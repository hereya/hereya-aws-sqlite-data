// Which databases moved while the replacement was warming up.
//
// This is the catch-up list of the handover (t_vm_zero_cut_handover), and the
// reason the design costs seconds instead of the 21.5 s a full restore takes.
//
// The replacement restores every app from S3 while the OLD instance is still
// serving, so anything written during that window is stale in its copy — and
// litestream offers no way to catch a live file up (restoring over an existing
// database is the stale-data trap invariant 2 forbids). The departing instance
// is the only process that knows which apps those were: `WriteStats` holds
// `lastWriteMs` per app, in memory, on the very process that served the writes.
//
// Measured shape of the fleet, which is why this is worth doing: 61 apps, of
// which the counter had ever seen **2** write. The list is normally empty.
import type { WriteStat } from "../write-stats/stat.ts";

/**
 * The `<orgId>/<appId>` keys written at or after `since`.
 *
 * `since` is the instant the replacement STARTED warming, not the instant it
 * finished: a write that lands between the start of the restore and its end is
 * exactly the one whose copy is stale, and it must be in the list. Using the
 * finish instant would silently drop it — the one failure here that serves a
 * customer an old version of their own data.
 *
 * Boundary included (`>=`) for the same reason: at equal milliseconds the
 * conservative reading is that the write may have missed the snapshot.
 */
export function dirtySince(stats: ReadonlyMap<string, WriteStat>, since: number): string[] {
  const out: string[] = [];
  for (const [key, stat] of stats) {
    if (stat.lastWriteMs > 0 && stat.lastWriteMs >= since) out.push(key);
  }
  return out.sort();
}

/** `<orgId>/<appId>` → the pair, for the caller that must re-restore it. */
export function splitAppKey(key: string): { orgId: string; appId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { orgId: key.slice(0, slash), appId: key.slice(slash + 1) };
}
