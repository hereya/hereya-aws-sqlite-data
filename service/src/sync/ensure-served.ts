// The promotion gate every data route awaits before a statement runs.
import { appKeyOf } from "../apps.ts";
import { ServiceError } from "../errors.ts";
import type { LitestreamApp } from "../litestream.ts";
import { log } from "./log.ts";
import type { SyncState } from "./state.ts";

/**
 * Request-path hot-add: the registry already said "active" (fail-closed
 * check done by the caller); make the app servable if it isn't yet.
 * Restore-if-missing runs BEFORE the first query so a replica in S3 can
 * never be shadowed by a freshly created empty file. A per-app mutex keeps
 * concurrent first-requests from racing the restore.
 */
export async function ensureServed(state: SyncState, orgId: string, appId: string): Promise<void> {
  const key = appKeyOf(orgId, appId);
  // Stamped BEFORE the early return, deliberately: the fast path is exactly
  // the one that leaves no other trace, and it is the one the eviction sweep
  // could otherwise cut in behind. See `lastTouch`.
  const touchedAt = Date.now();
  state.lastTouch.set(key, touchedAt);
  // Durable half — a Map.set on the sink, flushed on a timer. Never awaited:
  // the read path must not gain an I/O failure mode. See `touchSink`.
  state.touchSink?.recordTouch(key, touchedAt);
  // Served AND replicated: nothing to do — the overwhelmingly common path.
  if (state.served.has(key) && state.replicated.has(key)) return;
  const existing = state.pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    const app: LitestreamApp = { orgId, appId, dbPath: state.manager.dbPath(orgId, appId) };
    const wasServed = state.served.has(key);
    try {
      // Already served but not replicated = a never-written app being touched
      // for the first time. The local file is already correct, so restoring
      // again would be wrong (it would be a no-op at best); it only needs to
      // enter the config.
      if (!wasServed) {
        await state.litestream.restoreIfMissing(app);
        state.served.set(key, app);
      }
      // Under the config lock: the set is joined and the config rewritten
      // without any other bounce able to interleave between the two. This
      // await is what every data route is waiting on, so when it returns the
      // app is in the file litestream is reading — not merely in a Set.
      await state.withConfig(async () => {
        state.replicated.add(key);
        await state.litestream.bounce(state.replicatedApps);
      });
      log({ event: wasServed ? "promoted" : "hot-add", orgId, appId });
    } catch (err) {
      // Roll back only what this call added, so a failure cannot leave the
      // app half-registered — and never un-serve an app that was already
      // serving before we got here.
      state.replicated.delete(key);
      if (!wasServed) state.served.delete(key);
      throw new ServiceError("UNAVAILABLE", `app could not be prepared: ${(err as Error).message}`);
    } finally {
      state.pending.delete(key);
    }
  })();
  state.pending.set(key, task);
  return task;
}
