// The served set itself — the data every operation in this directory mutates,
// plus the two things that must never be read apart from it: the lock that
// serializes config writes, and the "when was this app last used" view.
//
// The operations live beside it (boot-restore, ensure-served, evict,
// reconcile); `AppSync` in ./app-sync.ts is the facade that owns one of these
// and hands it to them.
import type { AppManager } from "../apps.ts";
import { appKeyOf } from "../apps.ts";
import type { Litestream, LitestreamApp } from "../litestream.ts";
import type { Registry } from "../registry.ts";
import type { TouchSink } from "./touch-sink.ts";

export class SyncState {
  readonly registry: Registry;
  readonly manager: AppManager;
  readonly litestream: Litestream;
  readonly served = new Map<string, LitestreamApp>();
  /**
   * The apps litestream actually replicates — a SUBSET of `served`.
   *
   * An app that has never been written has no replica in S3 and no data on
   * disk; replicating it buys nothing and costs a per-database timer set that
   * LISTs the replica prefix on every tick, plus ~1 OS thread and ~0.46 MB of
   * litestream RSS. At 10 000 apps those timers are the whole S3 request bill
   * (measured 2026-08-24), and the threads are what caps how many apps a VM
   * can hold at all.
   *
   * So a `fresh` app is served (it can answer queries) but NOT replicated
   * (nothing is watching it). It is promoted the first time a request touches
   * it — see `ensureServed`, which every data route passes through BEFORE any
   * statement runs, so no acknowledged write can precede replication.
   *
   * The safety of this rests on one fact: a `fresh` app holds NO DATA. There is
   * nothing to lose by not replicating it — unlike evicting an app that has
   * data, which is a separate and genuinely risky design.
   */
  readonly replicated = new Set<string>();
  readonly pending = new Map<string, Promise<void>>();
  /**
   * Serializes every mutation of the litestream config.
   *
   * `bounce` rewrites the config file from a SNAPSHOT of the replicated set.
   * Two callers overlapping — a request promoting an app while the eviction
   * sweep or the registry poll bounces — could therefore let the later write
   * land a config computed before the earlier change, leaving an app inside
   * `replicated` but absent from the file litestream actually reads. That is
   * an app believed replicated and in fact unwatched: the exact silent-loss
   * shape this whole feature has to avoid.
   *
   * Holding a lock across "decide + mutate + bounce" makes the two views
   * impossible to disagree: whoever writes the config last computed it from the
   * set as it stood under this lock.
   */
  private configOp: Promise<unknown> = Promise.resolve();
  /**
   * When each app last passed through `ensureServed`.
   *
   * This exists to close a window that is invisible from either side alone.
   * `ensureServed` returns immediately when an app is already replicated — the
   * hot path — and the caller (`server.ts authorize()`) only acquires its
   * limiter slot AFTERWARDS. Between those two moments the app is in NOBODY's
   * count: `inFlight` is still zero and no transaction is open, so an eviction
   * sweep landing in that gap sees a perfectly idle app, drops it from the
   * config, and the statement that was already cleared to run writes to a
   * database litestream is no longer watching.
   *
   * A grace period on "was cleared to run recently" is what covers it, and it
   * costs nothing: the eviction threshold is measured in DAYS, so refusing to
   * evict an app touched in the last few minutes cannot change the outcome for
   * a genuinely inert one.
   */
  readonly lastTouch = new Map<string, number>();
  /**
   * The durable half of `lastTouch`.
   *
   * `lastTouch` is process memory, so it is empty for every app after an
   * instance replacement — and the guard above compares it against a threshold
   * measured in DAYS. Those two facts together meant that after each deploy an
   * app that is read constantly and never written looked untouched, and the
   * `recently-served` guard could not protect it (`t_3bdea3eeebb6`).
   *
   * The sink keeps the read path free: it is a `Map.set` here and a background
   * flush elsewhere, exactly like the write counter. Memory still wins when it
   * has an answer — it is strictly fresher — and this only fills the gap for
   * apps this instance has not been asked about yet.
   */
  touchSink: TouchSink | null = null;
  /** Boot-restore fan-out width; see bootRestoreAll. Defaults to the serial
   *  behaviour's successor rather than to 1, but callers that do not care
   *  (tests, the file registry) need not thread it through. */
  readonly concurrency: number;

  constructor(registry: Registry, manager: AppManager, litestream: Litestream, concurrency = 8) {
    this.registry = registry;
    this.manager = manager;
    this.litestream = litestream;
    this.concurrency = Math.max(1, concurrency);
  }

  /**
   * How long since this app was last used, memory first, store second.
   *
   * Null means "never seen by either", which stays evictable on purpose — the
   * one thing this must not do is invent a recent access for an app nobody has
   * touched, because that would switch eviction off entirely.
   */
  msSinceTouched(key: string, now: number): number | null {
    const local = this.lastTouch.get(key);
    if (local !== undefined) return Math.max(0, now - local);
    return this.touchSink?.msSinceTouch(key) ?? null;
  }

  /** Run `fn` with exclusive ownership of the litestream config. Runs after
   *  the previous holder settles, whether it resolved or threw — a failed
   *  bounce must not wedge every later one. */
  withConfig<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.configOp.then(fn, fn);
    this.configOp = run.catch(() => undefined);
    return run;
  }

  /** Every app this instance can answer queries for. */
  get servedApps(): LitestreamApp[] {
    return [...this.served.values()];
  }

  /** The apps litestream watches — what `buildConfig` must be given. */
  get replicatedApps(): LitestreamApp[] {
    const out: LitestreamApp[] = [];
    for (const [key, app] of this.served) if (this.replicated.has(key)) out.push(app);
    return out;
  }

  /** How many served apps are deliberately NOT replicated (never written). */
  get unusedCount(): number {
    return this.served.size - this.replicated.size;
  }

  isServed(orgId: string, appId: string): boolean {
    return this.served.has(appKeyOf(orgId, appId));
  }
}
