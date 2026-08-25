// Which replicated apps should STOP being replicated?
//
// An app that nobody writes still costs the shared VM every minute: litestream
// keeps a per-database timer set that LISTs its replica prefix on every tick,
// plus ~1 OS thread and ~0.46 MB of RSS. Those threads are what caps how many
// apps one VM can hold at all (~10 800 measured, recommendation 5 000), so an
// inert app is not merely a small bill — it consumes the scarce resource that
// every OTHER org shares.
//
// Eviction here means exactly one thing: the app leaves the litestream config.
// It stays SERVED, its local file stays on disk, and every read keeps working
// with no wake-up at all. Coming back is `AppSync.ensureServed`, which every
// data route already passes through BEFORE any statement runs — so an
// acknowledged write can never precede the app's return to replication. That
// pre-existing ordering is the whole reason this design is small; see
// `no-replication-until-used.test.ts`, which pins it for never-written apps.
//
// WHY IT IS SAFE TO STOP WATCHING AN APP THAT HAS DATA
//
// The obvious fear is stranding writes litestream had not yet shipped to S3.
// It cannot happen here, and the threshold is what guarantees it rather than
// any new flushing machinery: replication runs on a ~1 s sync interval
// (`litestreamSyncIntervalMs`), so anything written is in S3 seconds later.
// An app is only evictable after DAYS of not changing, which is six orders of
// magnitude more than the lag it would have to outrun. The eviction threshold
// is therefore not just an economic knob — it is the flush guarantee.
//
// THE ROLLOUT IS SAFE BY CONSTRUCTION, TOO
//
// Idleness is measured by the per-app write counter (`write-stats.ts`), whose
// history begins when it shipped (2026-08-24). `idleMs === null` — an app the
// counter has never seen change — is not evictable on that fact alone:
// absence of evidence is not evidence of idleness. So this ships inert and
// takes effect only as real idleness accumulates.
//
// BUT "WE HAVE NEVER SEEN IT WRITE" IS A CLAIM WITH A CLOCK ON IT
//
// That rule, left alone, has an end that undoes the feature. An app that never
// writes AT ALL would never become evictable — and it is precisely the app
// that costs the VM the most, since the cost is a timer set and a thread, not
// a byte written. On the evening the threshold went live, the counter had seen
// 2 of 61 apps write: the sweep could free nothing, and for 59 of them it never
// would.
//
// What breaks the tie is dating the observation itself
// (`WriteStats.observedForMs`, persisted in DynamoDB so a VM roll cannot
// restart the clock). While the counter has watched for LESS than the
// threshold, `null` still means "we do not know" and still protects the app.
// Once it has watched for LONGER than the threshold, `null` has stopped being
// ignorance: nothing wrote during a window that, by our own definition, is
// long enough to call an app idle. Absence of evidence became evidence of
// absence the moment the observation outlasted the claim.
//
// This changes WHICH apps are evictable, never what eviction does to one. An
// app admitted through this path is still put through every other guard below,
// and eviction still means only "litestream stops watching it until the next
// statement brings it back".
//
// WHY "IDLE" HAD TO STOP MEANING "UNWRITTEN" AND START MEANING "UNUSED"
//
// Widening the population exposed a cost the write-only signal had kept rare.
// `ensureServed` promotes an app on ANY access — it runs BEFORE the statement,
// so it cannot yet know a read from a write — and every promotion is a
// litestream bounce, which stops and respawns the single process replicating
// the WHOLE fleet. An app that is read often but never written is therefore
// the worst possible eviction candidate: evict it, the next read promotes it,
// the next sweep evicts it again. Hourly, per app, fleet-wide.
//
// Those apps are exactly what the new rule would have admitted first, so the
// definition of idle has to widen with it: an app this instance SERVED inside
// the threshold window is in use, whatever the write counter says. `lastTouch`
// answers that, and it answers it for reads too.
//
// It is deliberately per-INSTANCE, unlike the write history. Unknown ("this
// instance has not served it since boot") reads as evictable, and it has to:
// the alternative restarts the clock on every deploy, and a fleet that rolls
// weekly would never evict anything. The cost of that choice is one wave of
// promotions after each roll, bounded and one-off, instead of an unbounded
// hourly flap.

/** What the sweep needs to know about one app, injected so this stays pure. */
export interface EvictionProbe {
  /** ms since the app last CHANGED its database; null = never observed. */
  idleMs: (key: string) => number | null;
  /** Is a transaction open on it? */
  hasOpenTx: (key: string) => boolean;
  /** Statements currently executing against it. */
  inFlight: (key: string) => number;
  /**
   * How long the write counter has been watching, in ms; null = it cannot say.
   *
   * Global rather than per-app, and that is the correct shape: the apps this
   * answers for are exactly the ones with no row of their own to date.
   */
  observedForMs: () => number | null;
  /**
   * ms since this instance last served a request for the app — reads included;
   * null when it has not served one since boot.
   *
   * Supplied by `AppSync`, which owns the map. Null means evictable on
   * purpose: see the header.
   */
  msSinceServed: (key: string) => number | null;
}

/**
 * The half of the probe a caller injects.
 *
 * `msSinceServed` is excluded because `AppSync` owns the map behind it and
 * fills it in itself — the type says so rather than a comment asking callers
 * to pass a placeholder they cannot compute.
 */
export type InjectedEvictionProbe = Omit<EvictionProbe, "msSinceServed">;

/** Why an app was left alone — logged, so a sweep that frees nothing explains itself. */
export type EvictionSkip =
  | "never-observed"
  | "recently-written"
  | "recently-served"
  | "open-tx"
  | "in-flight";

export interface EvictionPlan {
  evict: string[];
  skipped: Record<EvictionSkip, number>;
  /**
   * How many of `evict` were admitted on a long-enough observation rather than
   * on a recorded write — the only number that says whether that rule is doing
   * anything, and the one to watch on the first sweep after it ships.
   */
  evictedUnobserved: number;
}

/**
 * Decide, for one sweep, which of the currently-replicated apps to drop.
 *
 * Every rule below errs toward keeping an app replicated. Over-replicating
 * costs a timer and a thread; under-replicating costs a customer their data,
 * and the two mistakes are not comparable.
 */
export function planEviction(
  replicatedKeys: readonly string[],
  probe: EvictionProbe,
  thresholdMs: number
): EvictionPlan {
  const skipped: Record<EvictionSkip, number> = {
    "never-observed": 0,
    "recently-written": 0,
    "recently-served": 0,
    "open-tx": 0,
    "in-flight": 0,
  };
  // A non-positive threshold disables eviction entirely — the off switch, and
  // the state the feature ships in until it is deliberately configured.
  if (!(thresholdMs > 0)) return { evict: [], skipped, evictedUnobserved: 0 };

  // Has the counter watched for longer than the window we call "idle"? Only
  // then does "never seen writing" carry any information. Null (the counter
  // cannot date itself) reads as no, which keeps every unobserved app.
  const observedFor = probe.observedForMs();
  const outlastsThreshold = observedFor !== null && observedFor > thresholdMs;

  const evict: string[] = [];
  let evictedUnobserved = 0;
  for (const key of replicatedKeys) {
    const idle = probe.idleMs(key);
    let unobserved = false;
    // Never seen change. Whether that is ignorance or inertness depends
    // entirely on how long we have been looking.
    if (idle === null) {
      if (!outlastsThreshold) {
        skipped["never-observed"] += 1;
        continue;
      }
      // Watched for longer than the threshold and it never wrote: idle, by the
      // same definition every other app here is judged with. It still has to
      // pass the guards below.
      unobserved = true;
    } else if (idle < thresholdMs) {
      skipped["recently-written"] += 1;
      continue;
    }
    // Served inside the window, by anyone, for anything. A promotion costs a
    // fleet-wide bounce, so evicting an app that is still being used does not
    // free a thread — it buys a bounce an hour. Null = not served since boot,
    // which is the state a fresh instance is in for every app it has not been
    // asked about, and it must stay evictable.
    const served = probe.msSinceServed(key);
    if (served !== null && served < thresholdMs) {
      skipped["recently-served"] += 1;
      continue;
    }
    // An open transaction may write at any moment, and its statements do NOT
    // re-enter ensureServed — `use()` only touches the tx registry. Dropping
    // replication under an open tx is precisely the silent-loss case.
    if (probe.hasOpenTx(key)) {
      skipped["open-tx"] += 1;
      continue;
    }
    // A statement already executing has passed ensureServed; evicting beneath
    // it would drop the app from the config while it may still be writing.
    if (probe.inFlight(key) > 0) {
      skipped["in-flight"] += 1;
      continue;
    }
    evict.push(key);
    if (unobserved) evictedUnobserved += 1;
  }
  return { evict, skipped, evictedUnobserved };
}

/**
 * How long after a request was cleared to run an app stays un-evictable.
 *
 * `AppSync.ensureServed` returns before the caller acquires its limiter slot,
 * so for a brief moment a statement is authorised to write while `inFlight` is
 * still zero — invisible to every other guard here. This grace covers that gap.
 * It must comfortably exceed a statement's own lifetime (`sqlTimeoutMs`, 1.5-30 s);
 * five minutes is generous on purpose, and free, because the threshold it defers
 * to is measured in days.
 */
export const EVICT_TOUCH_GRACE_MS = 5 * 60 * 1000;

/** Days → ms, the unit the threshold is actually reasoned about in. */
export function daysToMs(days: number): number {
  return days > 0 ? Math.round(days * 24 * 60 * 60 * 1000) : 0;
}
