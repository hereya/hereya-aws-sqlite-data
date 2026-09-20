// The two paths where the served set shrinks or is rebuilt from the registry:
// an explicit teardown, and the full reconcile.
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { appKeyOf } from "../apps.ts";
import type { LitestreamApp } from "../litestream.ts";
import { log } from "./log.ts";
import type { SyncState } from "./state.ts";

/**
 * Explicit teardown (connector drop-app flow): close the executor, drop the
 * app from the litestream config, delete the LOCAL file. The S3 replica is
 * retained as the durable archive. Idempotent; works whether or not the app
 * is currently served (its registry row is typically already non-active).
 */
export async function removeApp(state: SyncState, orgId: string, appId: string): Promise<void> {
  const key = appKeyOf(orgId, appId);
  const wasServed = state.served.delete(key);
  const wasReplicated = state.replicated.delete(key);
  await state.manager.removeApp(orgId, appId);
  try {
    // Only a REPLICATED app was in the config, so only its removal needs a
    // bounce — dropping an unused app changes nothing litestream can see.
    // BEFORE the file goes: litestream's per-database `stop` closes the
    // database, which fails on a deleted file and would cost a full bounce.
    if (wasReplicated) await state.withConfig(() => state.litestream.apply(state.replicatedApps));
  } finally {
    deleteLocal(state.manager.dbPath(orgId, appId), orgId, appId);
  }
  log({ event: "removed", orgId, appId, wasServed, wasReplicated });
}

function deleteLocal(dbPath: string, orgId: string, appId: string): void {
  try {
    rmSync(dirname(dbPath), { recursive: true, force: true });
  } catch (err) {
    log({ event: "remove-cleanup-failed", orgId, appId, message: (err as Error).message });
  }
}

/** Full reconcile: registry is the source of truth for adds AND removals. */
export async function doSync(state: SyncState): Promise<{ added: number; removed: number }> {
  await state.registry.reload();
  const active = await state.registry.listActive();
  const target = new Map(active.map((ref) => [appKeyOf(ref.orgId, ref.appId), ref]));

  let added = 0;
  let removed = 0;

  for (const [key, ref] of target) {
    if (state.served.has(key)) continue;
    const app: LitestreamApp = {
      orgId: ref.orgId,
      appId: ref.appId,
      dbPath: state.manager.dbPath(ref.orgId, ref.appId),
    };
    const outcome = await state.litestream.restoreIfMissing(app);
    state.served.set(key, app);
    if (outcome !== "fresh") state.replicated.add(key);
    added += 1;
  }

  const gone: LitestreamApp[] = [];
  for (const [key, app] of [...state.served]) {
    if (target.has(key)) continue;
    // Leaving through a MOVE: the mover settles it (sync/depart.ts). The poll
    // can land between the target's claim and that — and deleting the file
    // here is what the mover's one-hour safety copy was supposed to prevent.
    if (state.departing.has(key)) continue;
    state.served.delete(key);
    state.replicated.delete(key);
    await state.manager.removeApp(app.orgId, app.appId);
    gone.push(app);
    removed += 1;
  }

  try {
    if (added > 0 || removed > 0) {
      await state.withConfig(() => state.litestream.apply(state.replicatedApps));
    }
  } finally {
    // Local files go LAST (litestream stops a database before forgetting it,
    // and cannot stop a deleted one); the S3 replica is retained as the durable
    // archive (cleanup is a documented manual op — litestream retention stops
    // with replication, and no S3 lifecycle rule is allowed to touch it).
    for (const app of gone) {
      deleteLocal(app.dbPath, app.orgId, app.appId);
      log({ event: "removed", orgId: app.orgId, appId: app.appId });
    }
  }
  return { added, removed };
}
