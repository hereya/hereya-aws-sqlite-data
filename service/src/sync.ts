import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppManager } from "./apps.ts";
import { appKeyOf } from "./apps.ts";
import type { Litestream, LitestreamApp } from "./litestream.ts";
import type { Registry } from "./registry.ts";
import { ServiceError } from "./errors.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "sync", ...event }));
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
  private readonly pending = new Map<string, Promise<void>>();
  private syncing: Promise<{ added: number; removed: number }> | null = null;
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
        try {
          await this.litestream.restoreIfMissing(app);
        } catch (err) {
          if (firstError === null) firstError = err;
          return;
        }
        this.served.set(appKeyOf(ref.orgId, ref.appId), app);
      }
    };

    // allSettled, not all: every worker must finish before we rethrow, so a
    // failed boot never races its own leftover subprocesses.
    await Promise.allSettled(Array.from({ length: width }, () => worker()));
    if (firstError !== null) throw firstError;

    log({
      event: "boot-restore-complete",
      apps: this.served.size,
      concurrency: width,
      ms: Date.now() - startedAt,
    });
    return [...this.served.values()];
  }

  get servedApps(): LitestreamApp[] {
    return [...this.served.values()];
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
    if (this.served.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = (async () => {
      const app: LitestreamApp = { orgId, appId, dbPath: this.manager.dbPath(orgId, appId) };
      try {
        await this.litestream.restoreIfMissing(app);
        this.served.set(key, app);
        await this.litestream.bounce(this.servedApps);
        log({ event: "hot-add", orgId, appId });
      } catch (err) {
        this.served.delete(key);
        throw new ServiceError("UNAVAILABLE", `app could not be prepared: ${(err as Error).message}`);
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
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
    await this.manager.removeApp(orgId, appId);
    try {
      rmSync(dirname(this.manager.dbPath(orgId, appId)), { recursive: true, force: true });
    } catch (err) {
      log({ event: "remove-cleanup-failed", orgId, appId, message: (err as Error).message });
    }
    if (wasServed) await this.litestream.bounce(this.servedApps);
    log({ event: "removed", orgId, appId, wasServed });
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
      await this.litestream.restoreIfMissing(app);
      this.served.set(key, app);
      added += 1;
    }

    for (const [key, app] of [...this.served]) {
      if (target.has(key)) continue;
      this.served.delete(key);
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
      await this.litestream.bounce(this.servedApps);
    }
    return { added, removed };
  }
}
