// Which databases moved while the replacement was warming up.
//
// This is the catch-up list of the handover (t_vm_zero_cut_handover), and the
// reason the design costs seconds instead of the 21.5 s a full restore takes.
//
// The replacement restores every app from S3 while the OLD instance is still
// serving, so anything written during that window is stale in its copy — and
// litestream offers no way to catch a live file up (restoring over an existing
// database is the stale-data trap invariant 2 forbids). The departing instance
// is the only process that knows which apps those were.
//
// ⚠️ IT IS COUNTED, NOT TIMED — and that is the whole point of this file.
//
// The obvious implementation compares `lastWriteMs` against the instant the
// window opened. It is wrong here, for a reason that is invisible until you
// read `WriteStats.load()`: the counter is SEEDED FROM DYNAMODB at boot, so
// most `lastWriteMs` values in memory were written by PREVIOUS instances, on
// THEIR clocks. Comparing them against this machine's clock is exactly the
// cross-machine comparison the ordering rule bans (see record.ts) — and while
// its usual direction is harmless (over-report → re-restore a clean app →
// slow, not wrong), a clock that steps backwards during the window turns it
// into the dangerous one: a write that really happened reads as older than the
// window and is dropped from the list, and the replacement then serves a stale
// database.
//
// `WriteStat.writes` is a monotonic per-app counter incremented on every
// statement that CHANGED the database. Snapshot it when the window opens,
// compare at drain: an app is dirty iff its count moved. No timestamp is read,
// so no clock — ours or anyone else's — can make the answer wrong.
//
// Measured shape of the fleet, which is why this is worth doing at all: 61
// apps, of which the counter had ever seen **2** write. The list is normally
// empty.
import type { WriteStat } from "../write-stats/stat.ts";

/** What the counter held, per app, when the window opened. */
export type WriteCounts = ReadonlyMap<string, number>;

/** Take the snapshot. Called the moment the warming announcement is observed. */
export function snapshotWrites(stats: ReadonlyMap<string, WriteStat>): WriteCounts {
  return new Map([...stats].map(([key, stat]) => [key, stat.writes]));
}

/**
 * The `<orgId>/<appId>` keys whose write count moved since the snapshot.
 *
 * An app ABSENT from the snapshot but present now is dirty: it was first
 * written during the window (a count of 0 would be indistinguishable from
 * "seen but unwritten", so presence alone is not the test — `writes > 0` is).
 *
 * An app present in the snapshot and absent now is NOT listed: entries leave
 * the counter when the app itself is gone, and the catch-up list only covers
 * databases the replacement is going to serve.
 */
export function dirtySince(snapshot: WriteCounts, stats: ReadonlyMap<string, WriteStat>): string[] {
  const out: string[] = [];
  for (const [key, stat] of stats) {
    const before = snapshot.get(key);
    if (before === undefined ? stat.writes > 0 : stat.writes > before) out.push(key);
  }
  return out.sort();
}

/** `<orgId>/<appId>` → the pair, for the caller that must re-restore it. */
export function splitAppKey(key: string): { orgId: string; appId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { orgId: key.slice(0, slash), appId: key.slice(slash + 1) };
}
