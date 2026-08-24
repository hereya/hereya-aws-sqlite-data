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
// counter has never seen change — is deliberately NOT evictable: absence of
// evidence is not evidence of idleness. A consequence worth stating plainly:
// nothing can be evicted until the counter has actually observed an app go
// quiet for the full threshold, so this ships inert and takes effect only as
// real idleness accumulates.

/** What the sweep needs to know about one app, injected so this stays pure. */
export interface EvictionProbe {
  /** ms since the app last CHANGED its database; null = never observed. */
  idleMs: (key: string) => number | null;
  /** Is a transaction open on it? */
  hasOpenTx: (key: string) => boolean;
  /** Statements currently executing against it. */
  inFlight: (key: string) => number;
}

/** Why an app was left alone — logged, so a sweep that frees nothing explains itself. */
export type EvictionSkip = "never-observed" | "recently-written" | "open-tx" | "in-flight";

export interface EvictionPlan {
  evict: string[];
  skipped: Record<EvictionSkip, number>;
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
    "open-tx": 0,
    "in-flight": 0,
  };
  // A non-positive threshold disables eviction entirely — the off switch, and
  // the state the feature ships in until it is deliberately configured.
  if (!(thresholdMs > 0)) return { evict: [], skipped };

  const evict: string[] = [];
  for (const key of replicatedKeys) {
    const idle = probe.idleMs(key);
    // Never seen change. Could be genuinely inert, could be an app whose
    // history predates the counter. We cannot tell the two apart, so we keep
    // watching it.
    if (idle === null) {
      skipped["never-observed"] += 1;
      continue;
    }
    if (idle < thresholdMs) {
      skipped["recently-written"] += 1;
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
  }
  return { evict, skipped };
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
