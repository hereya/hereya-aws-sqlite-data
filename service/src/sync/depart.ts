// What a database MOVE does to the served set of the cell it leaves
// (t_dbmove_p4_move). The protocol lives in ../move/; this file only knows how
// to let go of one app, take it back, or forget it.
//
// ⚠️ A departing app STAYS in `served`. The reconcile (`doSync`) restores and
// REGISTERS any active app of this cell it does not find there — and until the
// target has claimed the move, placement still says the app is ours. Taking it
// out of `served` would hand it straight back to litestream at the next poll.
// It leaves `replicated` (so no config ever lists it) and enters `departing`
// (so no promotion can bring it back).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appKeyOf } from "../apps.ts";
import { log } from "./log.ts";
import type { SyncState } from "./state.ts";

/** Where a moved app's files wait before deletion — outside every org's
 *  directory, so the quota (which sums an org's LOCAL files) stops counting them. */
export const MOVED_DIR = "_moved";

/** Mark first: from here no promotion of this app can START (ensure-served.ts). */
export function markDeparting(state: SyncState, orgId: string, appId: string): void {
  const key = appKeyOf(orgId, appId);
  state.departing.set(key, { wasReplicated: state.replicated.has(key) });
}

/**
 * Close the executor, then have litestream sync, stop and forget the file —
 * OBSERVED, no bounce fallback (Litestream.detachOne). Throws when the stop
 * could not be observed; the caller aborts and calls `reattach`.
 */
export async function detach(state: SyncState, orgId: string, appId: string): Promise<void> {
  const key = appKeyOf(orgId, appId);
  const app = state.served.get(key);
  // The worker goes FIRST: an open connection could still write after the
  // final sync, and would keep serving a file that is no longer ours.
  await state.manager.removeApp(orgId, appId);
  if (!app) return;
  await state.withConfig(async () => {
    // Read HERE, under the config lock: a promotion the mover drained may have
    // finished after `markDeparting` took its first look.
    const wasReplicated = state.replicated.delete(key);
    state.departing.set(key, { wasReplicated });
    if (wasReplicated) await state.litestream.detachOne(app, state.replicatedApps);
  });
}

/**
 * The move was cancelled: the app is ours again, replicated BEFORE anything
 * runs. A bounce, not `apply`: after a half-done detach the daemon may hold the
 * database stopped-but-registered, which a diff against our own view cannot see.
 */
export async function reattach(state: SyncState, orgId: string, appId: string): Promise<void> {
  const key = appKeyOf(orgId, appId);
  const wasReplicated = state.departing.get(key)?.wasReplicated ?? false;
  try {
    if (wasReplicated && state.served.has(key)) {
      await state.withConfig(async () => {
        state.replicated.add(key);
        await state.litestream.bounce(state.replicatedApps);
      });
    }
  } finally {
    state.departing.delete(key);
  }
  log({ event: "move-reattached", orgId, appId, wasReplicated });
}

/** The move succeeded: stop serving it, and set its files aside for `keepMs`. */
export function forget(state: SyncState, orgId: string, appId: string, now = Date.now()): void {
  const key = appKeyOf(orgId, appId);
  state.served.delete(key);
  state.replicated.delete(key);
  state.departing.delete(key);
  state.lastTouch.delete(key);
  const appDir = dirname(state.manager.dbPath(orgId, appId));
  if (!existsSync(appDir)) return;
  const archive = join(dirname(dirname(appDir)), MOVED_DIR);
  try {
    mkdirSync(archive, { recursive: true });
    renameSync(appDir, join(archive, `${now}__${orgId}__${appId}`));
  } catch (err) {
    // A file we cannot set aside must not stay where a restore would find it.
    rmSync(appDir, { recursive: true, force: true });
    log({ event: "move-archive-failed", orgId, appId, message: (err as Error).message });
  }
}

/** Delete the set-aside copies older than `keepMs`. Returns how many went. */
export function sweepMoved(dbDir: string, keepMs: number, now = Date.now()): number {
  const archive = join(dbDir, MOVED_DIR);
  if (!existsSync(archive)) return 0;
  let removed = 0;
  for (const name of readdirSync(archive)) {
    const at = Number(name.split("__")[0]);
    if (Number.isFinite(at) && now - at < keepMs) continue;
    rmSync(join(archive, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * The app ARRIVES here: whatever copy this cell kept from an earlier stay is
 * stale by definition — `restoreIfMissing` would serve it as "existing".
 * Refuses when the app is served here: then the local file is live data.
 */
export async function clearForArrival(state: SyncState, orgId: string, appId: string): Promise<void> {
  const key = appKeyOf(orgId, appId);
  if (state.served.has(key) || state.pending.has(key)) {
    throw new Error("the target cell already serves this app");
  }
  await state.manager.removeApp(orgId, appId);
  rmSync(dirname(state.manager.dbPath(orgId, appId)), { recursive: true, force: true });
  state.departing.delete(key);
}
