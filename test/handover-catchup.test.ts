// The catch-up deletes customer database files, so what is pinned here is when
// it is allowed to, and what it leaves behind (t_vm_zero_cut_handover).
//
// The dangerous shapes, in order:
//   1. It must NEVER run on a timeout. A timeout means the predecessor did not
//      prove it stopped, so its unshipped writes may still be in flight — and
//      deleting our copy to re-pull the replica would then lose them.
//   2. It must close our own connection BEFORE unlinking, or the worker keeps
//      serving a deleted inode for ever while the fresh file sits beside it.
//   3. `dirtyUnknown` must widen to every served app, never narrow to none.
//   4. One app that cannot be re-restored must not take the boot down with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catchUp, localArtifacts } from "../service/src/handover/catchup.ts";
import { runHandoverGate } from "../service/src/handover/gate.ts";
import type { Config } from "../service/src/config.ts";

const cfg = { handoverTimeoutMs: 50, handoverAckMs: 0, handoverOverlapTimeoutMs: 50, handoverEnabled: true } as Config;

/** A db on disk with its sidecars and litestream staging dir. */
function seedApp(root: string, orgId: string, appId: string): string {
  const dbPath = join(root, orgId, appId, "app.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const p of localArtifacts(dbPath)) {
    if (p.endsWith("-litestream")) {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "state"), "stale generation");
    } else {
      writeFileSync(p, "stale bytes");
    }
  }
  return dbPath;
}

function deps(root: string, opts: { failRestore?: string[] } = {}) {
  const closed: string[] = [];
  const restored: string[] = [];
  return {
    closed,
    restored,
    catchUpDeps: {
      manager: {
        dbPath: (orgId: string, appId: string) => join(root, orgId, appId, "app.db"),
        removeApp: async (orgId: string, appId: string) => {
          const stillThere = existsSync(join(root, orgId, appId, "app.db"));
          closed.push(`${orgId}/${appId}:${stillThere ? "before-unlink" : "AFTER-UNLINK"}`);
        },
      },
      litestream: {
        restoreIfMissing: async (app: { orgId: string; appId: string; dbPath: string }) => {
          const key = `${app.orgId}/${app.appId}`;
          if (opts.failRestore?.includes(key)) throw new Error("replica unreachable");
          // A real restore recreates the file; assert here that we were given
          // a clean slate, which is the whole point of the deletion.
          assert.equal(existsSync(app.dbPath), false, `${key} was not deleted before restore`);
          writeFileSync(app.dbPath, "fresh from replica");
          restored.push(key);
          return "restored" as const;
        },
      },
      serves: () => true,
    },
  };
}

test("it deletes the db, its sidecars AND litestream's staging dir before restoring", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchup-"));
  const dbPath = seedApp(root, "org-a", "app-1");
  const d = deps(root);
  const done = await catchUp(d.catchUpDeps, ["org-a/app-1"]);

  assert.deepEqual(done, ["org-a/app-1"]);
  // Unlinking first would leave the worker holding a deleted inode: it would
  // serve the stale copy for ever while the restored file sat beside it.
  assert.deepEqual(d.closed, ["org-a/app-1:before-unlink"]);
  assert.deepEqual(d.restored, ["org-a/app-1"]);
  // The staging dir must be gone: leaving it beside a freshly restored file
  // hands litestream a generation that no longer corresponds to anything.
  const staging = localArtifacts(dbPath).find((p) => p.endsWith("-litestream"))!;
  assert.equal(existsSync(staging), false, "the litestream staging dir must be removed");
  assert.equal(existsSync(`${dbPath}-wal`), false);
  assert.equal(existsSync(`${dbPath}-shm`), false);
});

test("an app this instance does not serve is skipped, not restored", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchup-"));
  seedApp(root, "org-a", "app-1");
  const d = deps(root);
  const done = await catchUp({ ...d.catchUpDeps, serves: () => false }, ["org-a/app-1"]);
  assert.deepEqual(done, []);
  assert.deepEqual(d.closed, [], "nothing may be touched for an app we do not serve");
  assert.equal(existsSync(join(root, "org-a", "app-1", "app.db")), true, "its file must survive untouched");
});

test("one app that cannot be re-restored does not stop the others", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchup-"));
  seedApp(root, "org-a", "app-1");
  seedApp(root, "org-a", "app-2");
  const d = deps(root, { failRestore: ["org-a/app-1"] });
  const done = await catchUp(d.catchUpDeps, ["org-a/app-1", "org-a/app-2"]);
  assert.deepEqual(done, ["org-a/app-2"], "the healthy app is still caught up");
});

test("a TIMEOUT never reaches the catch-up — nothing is deleted on an unproven stop", async () => {
  // The predecessor never published. Its unshipped writes may still be in
  // flight, so discarding our copy to re-pull the replica could lose them.
  const store = { send: async () => ({ Item: undefined }) } as never;
  let clock = 0;
  let catchUpCalled = false;
  await runHandoverGate(cfg, {
    client: store,
    tableName: "registry",
    now: () => clock,
    sleep: async () => void (clock += 100),
    instanceId: "i-new",
    baseline: null,
    announcedAtMs: 0,
    completeLaunch: async () => false,
    peers: async () => null,
    servedKeys: () => ["org-a/app-1"],
    catchUpDeps: {
      manager: {
        dbPath: () => "/nope",
        removeApp: async () => void (catchUpCalled = true),
      },
      litestream: { restoreIfMissing: async () => "restored" as const },
      serves: () => true,
    },
  });
  assert.equal(catchUpCalled, false, "a timeout must never delete a database");
});
