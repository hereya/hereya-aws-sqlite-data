import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppManager } from "./apps.ts";
import { appKeyOf } from "./apps.ts";
import type { Litestream, LitestreamApp } from "./litestream.ts";
import type { Registry } from "./registry.ts";
import { ServiceError } from "./errors.ts";
import {
  EVICT_TOUCH_GRACE_MS,
  planEviction,
  type EvictionPlan,
  type EvictionProbe,
  type InjectedEvictionProbe,
} from "./eviction.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "sync", ...event }));
}

/**
 * The durable side of "when was this app last used".
 *
 * Deliberately narrower than `WriteStats`, which is what implements it in
 * production: `AppSync` has no business knowing about DynamoDB, counters or
 * flush timers, and the unit tests get a two-method stub instead of a fake
 * cloud. Both methods must be synchronous and non-throwing — `recordTouch`
 * runs on the read path of every customer request.
 */
export interface TouchSink {
  /** Someone used this app, at `atMs`. Memory only; persistence is the sink's. */
  recordTouch(key: string, atMs: number): void;
  /** Milliseconds since the last persisted access; null when never seen. */
  msSinceTouch(key: string): number | null;
}

/**
 * Owns the "served set": which apps have a restored local db and are covered
 * by the litestream config. Reconciles it against the registry at boot, on the
 * poll interval, on /admin/sync, and on-demand when a request hits an app the
 * registry knows but this instance doesn't serve yet (hot-add without restart).
 */
export class AppSync {
  private readonly registry: Registry;
  private readonly manager: AppManager;
  private readonly litestream: Litestream;
  private readonly served = new Map<string, LitestreamApp>();
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
  private readonly replicated = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private syncing: Promise<{ added: number; removed: number }> | null = null;
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
  private readonly lastTouch = new Map<string, number>();
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
  private touchSink: TouchSink | null = null;
  /** Boot-restore fan-out width; see bootRestoreAll. Defaults to the serial
   *  behaviour's successor rather than to 1, but callers that do not care
   *  (tests, the file registry) need not thread it through. */
  private readonly concurrency: number;

  constructor(registry: Registry, manager: AppManager, litestream: Litestream, concurrency = 8) {
    this.registry = registry;
    this.manager = manager;
    this.litestream = litestream;
    this.concurrency = Math.max(1, concurrency);
  }

  /**
   * Attach the durable touch store. Optional: without it every behaviour below
   * is exactly what it was before, which is what keeps the file registry and
   * the unit tests free of a DynamoDB dependency.
   */
  setTouchSink(sink: TouchSink): void {
    this.touchSink = sink;
  }

  /**
   * How long since this app was last used, memory first, store second.
   *
   * Null means "never seen by either", which stays evictable on purpose — the
   * one thing this must not do is invent a recent access for an app nobody has
   * touched, because that would switch eviction off entirely.
   */
  private msSinceTouched(key: string, now: number): number | null {
    const local = this.lastTouch.get(key);
    if (local !== undefined) return Math.max(0, now - local);
    return this.touchSink?.msSinceTouch(key) ?? null;
  }

  /**
   * Spec §4 steps 2-3: restore every active app BEFORE the API binds.
   *
   * Invariant 2 is untouched: this still returns only once EVERY active app has
   * been restored, and boot.ts binds the port only after it returns. What
   * changed on 2026-08-24 is the order inside that window — the apps used to be
   * restored one after another, and the whole window is a total outage (no org
   * can read or write until it ends).
   *
   * Why concurrency is the right lever here, rather than restoring lazily on
   * first access: the window was measured on prod, and it is latency-bound.
   * 61 apps took 72s, but 54 of the 61 inter-restore gaps were exactly 1s and
   * only one was 14s — one org holds 1320 MB of the fleet's 1352 MB, so ~58 of
   * those seconds were fixed per-app overhead (subprocess spawn + S3
   * round-trips) spent on near-empty databases. Fixed overhead paid serially is
   * exactly what a bounded worker pool removes, and it removes it WITHOUT
   * weakening the restore-then-serve guarantee that lazy restore would trade
   * away.
   *
   * The bound matters as much as the concurrency: each restore is a litestream
   * subprocess, so an unbounded fan-out would spawn one per app on a t4g.micro
   * with 916 MB of RAM. Hence `cfg.bootRestoreConcurrency` workers draining a
   * shared cursor rather than `Promise.all` over every app.
   *
   * Failure semantics are preserved deliberately: boot.ts documents that any
   * failure here aborts the boot, because serving an app whose replica did not
   * come back would silently present an empty database as if it were the
   * customer's data. The first error is therefore rethrown — but only after
   * every in-flight worker has settled, so a failing boot cannot leave orphan
   * restore subprocesses behind it.
   */
  async bootRestoreAll(): Promise<LitestreamApp[]> {
    const active = await this.registry.listActive();
    const width = Math.max(1, Math.min(this.concurrency, active.length));
    const startedAt = Date.now();

    let cursor = 0;
    let firstError: unknown = null;

    const worker = async (): Promise<void> => {
      for (;;) {
        // Stop handing out work as soon as any worker has failed: the boot is
        // already doomed, and every extra restore is a subprocess we would then
        // have to wait on.
        if (firstError !== null) return;
        const index = cursor++;
        if (index >= active.length) return;
        const ref = active[index]!;
        const app: LitestreamApp = {
          orgId: ref.orgId,
          appId: ref.appId,
          dbPath: this.manager.dbPath(ref.orgId, ref.appId),
        };
        let outcome;
        try {
          outcome = await this.litestream.restoreIfMissing(app);
        } catch (err) {
          if (firstError === null) firstError = err;
          return;
        }
        const key = appKeyOf(ref.orgId, ref.appId);
        this.served.set(key, app);
        // "fresh" = no replica existed = never written. Leave it out of the
        // config; a request promotes it. Anything else HAS data and must be
        // replicated from the start.
        if (outcome !== "fresh") this.replicated.add(key);
      }
    };

    // allSettled, not all: every worker must finish before we rethrow, so a
    // failed boot never races its own leftover subprocesses.
    await Promise.allSettled(Array.from({ length: width }, () => worker()));
    if (firstError !== null) throw firstError;

    log({
      event: "boot-restore-complete",
      apps: this.served.size,
      replicated: this.replicated.size,
      unusedSkipped: this.served.size - this.replicated.size,
      concurrency: width,
      ms: Date.now() - startedAt,
    });
    return this.replicatedApps;
  }

  /** Run `fn` with exclusive ownership of the litestream config. Runs after
   *  the previous holder settles, whether it resolved or threw — a failed
   *  bounce must not wedge every later one. */
  private withConfig<T>(fn: () => Promise<T>): Promise<T> {
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

  /**
   * Request-path hot-add: the registry already said "active" (fail-closed
   * check done by the caller); make the app servable if it isn't yet.
   * Restore-if-missing runs BEFORE the first query so a replica in S3 can
   * never be shadowed by a freshly created empty file. A per-app mutex keeps
   * concurrent first-requests from racing the restore.
   */
  async ensureServed(orgId: string, appId: string): Promise<void> {
    const key = appKeyOf(orgId, appId);
    // Stamped BEFORE the early return, deliberately: the fast path is exactly
    // the one that leaves no other trace, and it is the one the eviction sweep
    // could otherwise cut in behind. See `lastTouch`.
    const touchedAt = Date.now();
    this.lastTouch.set(key, touchedAt);
    // Durable half — a Map.set on the sink, flushed on a timer. Never awaited:
    // the read path must not gain an I/O failure mode. See `touchSink`.
    this.touchSink?.recordTouch(key, touchedAt);
    // Served AND replicated: nothing to do — the overwhelmingly common path.
    if (this.served.has(key) && this.replicated.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = (async () => {
      const app: LitestreamApp = { orgId, appId, dbPath: this.manager.dbPath(orgId, appId) };
      const wasServed = this.served.has(key);
      try {
        // Already served but not replicated = a never-written app being touched
        // for the first time. The local file is already correct, so restoring
        // again would be wrong (it would be a no-op at best); it only needs to
        // enter the config.
        if (!wasServed) {
          await this.litestream.restoreIfMissing(app);
          this.served.set(key, app);
        }
        // Under the config lock: the set is joined and the config rewritten
        // without any other bounce able to interleave between the two. This
        // await is what every data route is waiting on, so when it returns the
        // app is in the file litestream is reading — not merely in a Set.
        await this.withConfig(async () => {
          this.replicated.add(key);
          await this.litestream.bounce(this.replicatedApps);
        });
        log({ event: wasServed ? "promoted" : "hot-add", orgId, appId });
      } catch (err) {
        // Roll back only what this call added, so a failure cannot leave the
        // app half-registered — and never un-serve an app that was already
        // serving before we got here.
        this.replicated.delete(key);
        if (!wasServed) this.served.delete(key);
        throw new ServiceError("UNAVAILABLE", `app could not be prepared: ${(err as Error).message}`);
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  /**
   * Drop every app that has been quiet for `thresholdMs` from the litestream
   * config — one bounce for the whole batch, not one per app.
   *
   * The plan is computed INSIDE the config lock, deliberately. A plan made
   * outside it can go stale in the microseconds before it is applied: a request
   * arriving in that window promotes its app (and writes to it), and applying
   * the older decision afterwards would evict an app that had just been
   * written. Deciding under the lock means the idleness, the open-transaction
   * check and the in-flight count are all read from the same instant the
   * config is rewritten from.
   *
   * Apps mid-promotion (`pending`) are excluded outright: that promise is a
   * request waiting to write.
   *
   * Nothing is restored, deleted or closed here. The app stays served, its file
   * stays on disk, reads keep working untouched — the only thing that changes
   * is that litestream stops watching it until the next statement brings it
   * back through `ensureServed`.
   */
  async evictIdle(probe: InjectedEvictionProbe, thresholdMs: number): Promise<EvictionPlan> {
    return this.withConfig(async () => {
      const now = Date.now();
      // `lastTouch` is ours, not the caller's, so the planner is handed a view
      // of it rather than boot.ts having to reach in here. It answers "has
      // anyone used this app lately", reads included — the question the write
      // counter cannot answer and `ensureServed` implicitly asks on every
      // request. See src/eviction.ts.
      const withServed: EvictionProbe = {
        ...probe,
        msSinceServed: (key) => this.msSinceTouched(key, now),
      };
      const candidates = [...this.replicated].filter((key) => {
        // Mid-promotion: that promise is a request waiting to write.
        if (this.pending.has(key)) return false;
        // Cleared to run moments ago: its statement may not have reached the
        // limiter yet, so no other check can see it. The persisted mark is a
        // valid answer here too — it is at worst one flush interval stale, and
        // staleness in this direction only KEEPS an app, which is the safe side.
        const since = this.msSinceTouched(key, now);
        return since === null || since >= EVICT_TOUCH_GRACE_MS;
      });
      const plan = planEviction(candidates, withServed, thresholdMs);
      if (plan.evict.length === 0) return plan;
      for (const key of plan.evict) this.replicated.delete(key);
      await this.litestream.bounce(this.replicatedApps);
      log({
        event: "evicted",
        apps: plan.evict.length,
        // How many were freed on "watched longer than the threshold, never
        // wrote" rather than on a recorded write going stale.
        unobserved: plan.evictedUnobserved,
        stillReplicated: this.replicated.size,
        served: this.served.size,
        skipped: plan.skipped,
      });
      return plan;
    });
  }

  /**
   * Explicit teardown (connector drop-app flow): close the executor, drop the
   * app from the litestream config, delete the LOCAL file. The S3 replica is
   * retained as the durable archive. Idempotent; works whether or not the app
   * is currently served (its registry row is typically already non-active).
   */
  async removeApp(orgId: string, appId: string): Promise<void> {
    const key = appKeyOf(orgId, appId);
    const wasServed = this.served.delete(key);
    const wasReplicated = this.replicated.delete(key);
    await this.manager.removeApp(orgId, appId);
    try {
      rmSync(dirname(this.manager.dbPath(orgId, appId)), { recursive: true, force: true });
    } catch (err) {
      log({ event: "remove-cleanup-failed", orgId, appId, message: (err as Error).message });
    }
    // Only a REPLICATED app was in the config, so only its removal needs a
    // bounce — dropping an unused app changes nothing litestream can see.
    if (wasReplicated) await this.withConfig(() => this.litestream.bounce(this.replicatedApps));
    log({ event: "removed", orgId, appId, wasServed, wasReplicated });
  }

  /** Full reconcile: registry is the source of truth for adds AND removals. */
  async syncOnce(): Promise<{ added: number; removed: number }> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<{ added: number; removed: number }> {
    await this.registry.reload();
    const active = await this.registry.listActive();
    const target = new Map(active.map((ref) => [appKeyOf(ref.orgId, ref.appId), ref]));

    let added = 0;
    let removed = 0;

    for (const [key, ref] of target) {
      if (this.served.has(key)) continue;
      const app: LitestreamApp = {
        orgId: ref.orgId,
        appId: ref.appId,
        dbPath: this.manager.dbPath(ref.orgId, ref.appId),
      };
      const outcome = await this.litestream.restoreIfMissing(app);
      this.served.set(key, app);
      if (outcome !== "fresh") this.replicated.add(key);
      added += 1;
    }

    for (const [key, app] of [...this.served]) {
      if (target.has(key)) continue;
      this.served.delete(key);
      this.replicated.delete(key);
      await this.manager.removeApp(app.orgId, app.appId);
      // Local file goes; the S3 replica is retained as the durable archive
      // (cleanup is a documented manual op — litestream retention stops with
      // replication, and no S3 lifecycle rule is allowed to touch it).
      try {
        rmSync(dirname(app.dbPath), { recursive: true, force: true });
      } catch (err) {
        log({ event: "remove-cleanup-failed", orgId: app.orgId, appId: app.appId, message: (err as Error).message });
      }
      removed += 1;
      log({ event: "removed", orgId: app.orgId, appId: app.appId });
    }

    if (added > 0 || removed > 0) {
      await this.withConfig(() => this.litestream.bounce(this.replicatedApps));
    }
    return { added, removed };
  }
}
