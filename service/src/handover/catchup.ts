// Re-restoring the databases that moved while we were warming up.
//
// ⚠️ THIS FILE DELETES CUSTOMER DATABASE FILES. It is the single most dangerous
// thing the handover does, and the only place in the service that deliberately
// does what invariant 2 forbids — "never restore over an existing local file".
//
// WHY IT IS SAFE HERE, AND ONLY HERE. Invariant 2 protects against clobbering
// local writes that the replica has not yet received. At the moment this runs,
// that cannot be true of these files:
//
//   • the previous instance has PROVABLY stopped — `publishHandover` is called
//     only after `Litestream.stop()` returned, which waits for the child to
//     exit — so no process is still writing to the replica;
//   • before stopping it checkpointed every served app and gave litestream its
//     final sync window (`Shutdown.begin`), so the replica holds those writes;
//   • and THIS instance has never written to these files: it restored them
//     while warming and has not yet registered in Cloud Map, so no request has
//     reached it. The local copy is a stale READ, never an unreplicated write.
//
// Take any one of those away and this becomes data loss, which is why the
// caller may only reach it through a proven handover — never on a timeout.
//
// WHAT IT DELETES. The database, its WAL and SHM sidecars, and litestream's
// local staging directory. The staging directory matters: it holds the
// generation state for the copy we are throwing away, and leaving it next to a
// freshly restored file invites litestream to reason about a generation that no
// longer corresponds to anything.
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppManager } from "../apps.ts";
import type { Litestream, LitestreamApp } from "../litestream.ts";
import { splitAppKey } from "./dirty.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

/** The db, its sidecars, and litestream's staging dir for it. */
export function localArtifacts(dbPath: string): string[] {
  return [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    join(dirname(dbPath), `.${dbPath.split("/").pop()}-litestream`),
  ];
}

export interface CatchUpDeps {
  manager: Pick<AppManager, "dbPath" | "removeApp">;
  litestream: Pick<Litestream, "restoreIfMissing">;
  /** The apps this instance actually serves — anything else is not ours to
   *  restore, and a key naming one is ignored rather than acted on. */
  serves: (orgId: string, appId: string) => boolean;
}

/**
 * Re-restore each named app from the replica, discarding our stale copy.
 *
 * Returns the keys actually restored. Failures are reported per app and do NOT
 * abort the rest: one app that cannot be re-restored must not keep the whole
 * fleet unserved — but it IS logged at error level, because that app is now
 * serving a copy we know to be stale.
 */
export async function catchUp(deps: CatchUpDeps, appKeys: readonly string[]): Promise<string[]> {
  const done: string[] = [];
  for (const key of appKeys) {
    const pair = splitAppKey(key);
    if (pair === null) {
      log({ event: "catchup-skipped", key, reason: "malformed" });
      continue;
    }
    const { orgId, appId } = pair;
    if (!deps.serves(orgId, appId)) {
      log({ event: "catchup-skipped", key, reason: "not-served-here" });
      continue;
    }
    const dbPath = deps.manager.dbPath(orgId, appId);
    try {
      // Close our connection FIRST: deleting a file out from under an open
      // SQLite handle leaves the worker holding a deleted inode, which then
      // serves the stale copy for ever while the new file sits beside it.
      await deps.manager.removeApp(orgId, appId);
      for (const path of localArtifacts(dbPath)) {
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      }
      const app: LitestreamApp = { orgId, appId, dbPath };
      const outcome = await deps.litestream.restoreIfMissing(app);
      log({ event: "caught-up", key, outcome });
      done.push(key);
    } catch (err) {
      console.error(
        JSON.stringify({
          type: "handover",
          event: "catchup-failed",
          key,
          message: (err as Error).message,
          warning: "this app is now serving a copy known to be stale",
        }),
      );
    }
  }
  return done;
}
