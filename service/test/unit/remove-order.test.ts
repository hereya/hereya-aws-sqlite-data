// A removed app leaves litestream BEFORE its file leaves the disk.
//
// litestream's per-database `stop` closes the database and fails on a deleted
// file (`ensure wal exists: disk I/O error`). With the file deleted first, every
// app removal would fail on the control socket and fall back to the full bounce
// — silently putting back the fleet-wide pause the socket exists to remove.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AppSync } from "../../src/sync.ts";
import type { AppManager } from "../../src/apps.ts";
import type { Litestream, LitestreamApp } from "../../src/litestream.ts";
import type { Registry } from "../../src/registry.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "remove-order-"));
  const dbPath = (o: string, a: string) => join(dir, o, a, "app.db");
  let active = ["app-a", "app-b"];
  /** Whether app-b's file was still there each time the config was applied. */
  const fileSeenAtApply: boolean[] = [];
  const ls = {
    async restoreIfMissing(app: LitestreamApp) {
      mkdirSync(dirname(app.dbPath), { recursive: true });
      writeFileSync(app.dbPath, "");
      return "restored" as const;
    },
    async apply() {
      fileSeenAtApply.push(existsSync(dbPath("org", "app-b")));
    },
  } as unknown as Litestream;
  const registry = {
    reload: async () => {},
    listActive: async () => active.map((appId) => ({ orgId: "org", appId })),
  } as unknown as Registry;
  const manager = { dbPath, removeApp: async () => {} } as unknown as AppManager;
  return {
    dir,
    dbPath,
    fileSeenAtApply,
    sync: new AppSync(registry, manager, ls, 2),
    deactivate: (id: string) => (active = active.filter((a) => a !== id)),
  };
}

test("explicit teardown: litestream lets go of the database before the file is deleted", async () => {
  const f = fixture();
  try {
    await f.sync.bootRestoreAll();
    await f.sync.removeApp("org", "app-b");
    assert.deepEqual(f.fileSeenAtApply, [true]);
    assert.equal(existsSync(f.dbPath("org", "app-b")), false, "and the file does go afterwards");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("registry reconcile: same order for an app that stopped being active", async () => {
  const f = fixture();
  try {
    await f.sync.bootRestoreAll();
    f.deactivate("app-b");
    const result = await f.sync.syncOnce();
    assert.equal(result.removed, 1);
    assert.deepEqual(f.fileSeenAtApply, [true]);
    assert.equal(existsSync(f.dbPath("org", "app-b")), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
