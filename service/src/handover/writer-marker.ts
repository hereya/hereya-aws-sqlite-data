// "This instance was THE litestream writer" — a fact that must survive a crash
// of the process (t_handover_stale_ack_wipe).
//
// The handover gate is the REPLACEMENT's logic: wait for a predecessor, then
// re-restore what moved — deleting local files that, on a replacement, are
// stale reads nobody ever wrote to. A process that restarts on the instance
// that was SERVING is the opposite case: its files carry acknowledged writes
// no replica may have yet, there is no predecessor to wait for (it IS the
// predecessor of whoever comes next), and every second spent in the gate is a
// second served without replication. Nothing in DynamoDB tells the two apart
// — the instance id is the same, the records outlive the process — so the
// instance remembers it, on the disk whose lifetime is exactly the instance's.
//
//   written   once replication has started (boot step 5)
//   removed   once litestream has STOPPED on a clean shutdown, BEFORE the
//             handover report is published — after the report the replacement
//             starts writing, and a restart of ours must go through the gate
//             like anybody else rather than start a second writer.
//
// A crash publishes no report and leaves the marker: exactly the case it is for.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = ".litestream-writer";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

export function wasWriter(dbDir: string): boolean {
  return existsSync(join(dbDir, MARKER));
}

/** Never throws: a marker that cannot be written costs a slower restart, not a boot. */
export function markWriter(dbDir: string): void {
  try {
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, MARKER), new Date().toISOString());
  } catch (err) {
    log({ event: "writer-marker-failed", message: (err as Error).message });
  }
}

/**
 * False = the marker could NOT be removed, and the caller must then NOT publish
 * its handover report: a marker left behind after a reported stop is a second
 * writer in waiting. Better a slow roll (the replacement waits for the ASG).
 */
export function clearWriter(dbDir: string): boolean {
  try {
    rmSync(join(dbDir, MARKER), { force: true });
    return true;
  } catch (err) {
    log({ event: "writer-marker-stuck", message: (err as Error).message });
    return false;
  }
}
