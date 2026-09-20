// What a move does to the served set of the cell it leaves (sync/depart.ts).
// The trap pinned here: a departing app must NOT be handed back to litestream
// by the two paths that register databases — the reconcile and the promotion.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AppManager } from "../../src/apps.ts";
import type { Litestream, LitestreamApp } from "../../src/litestream.ts";
import type { Registry } from "../../src/registry.ts";
import { AppSync } from "../../src/sync.ts";
import { MOVED_DIR, sweepMoved } from "../../src/sync/depart.ts";

function fixture(opts: { detachFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "depart-"));
  const dbPath = (o: string, a: string) => join(dir, o, a, "app.db");
  const calls: string[] = [];
  const names = (apps: LitestreamApp[]) => apps.map((a) => a.appId).sort().join(",");
  const ls = {
    async restoreIfMissing(app: LitestreamApp) {
      if (existsSync(app.dbPath)) return "existing" as const;
      mkdirSync(dirname(app.dbPath), { recursive: true });
      writeFileSync(app.dbPath, "data");
      return "restored" as const;
    },
    async apply(apps: LitestreamApp[]) {
      calls.push(`apply(${names(apps)})`);
    },
    async bounce(apps: LitestreamApp[]) {
      calls.push(`bounce(${names(apps)})`);
    },
    async detachOne(app: LitestreamApp, remaining: LitestreamApp[]) {
      calls.push(`detach(${app.appId};${names(remaining)})`);
      if (opts.detachFails) throw new Error("litestream stop failed");
      return true;
    },
  } as unknown as Litestream;
  const registry = { reload: async () => {}, listActive: async () => ["app-a", "app-b"].map((appId) => ({ orgId: "org", appId })) } as unknown as Registry;
  const manager = { dbPath, removeApp: async (_o: string, a: string) => void calls.push(`close(${a})`) } as unknown as AppManager;
  return { dir, dbPath, calls, sync: new AppSync(registry, manager, ls, 2) };
}

test("detach: the worker closes FIRST, litestream lets go of that one database, the app stays served", async () => {
  const f = fixture();
  await f.sync.bootRestoreAll();
  f.sync.move.markDeparting("org", "app-a");
  await f.sync.move.detach("org", "app-a");
  assert.deepEqual(f.calls, ["close(app-a)", "detach(app-a;app-b)"]);
  assert.equal(f.sync.isServed("org", "app-a"), true);
  assert.deepEqual(f.sync.replicatedApps.map((a) => a.appId), ["app-b"]);
});

test("a departing app is handed back to litestream by NOBODY: not the reconcile, not a promotion", async () => {
  const f = fixture();
  await f.sync.bootRestoreAll();
  f.sync.move.markDeparting("org", "app-a");
  await f.sync.move.detach("org", "app-a");
  f.calls.length = 0;
  assert.deepEqual(await f.sync.syncOnce(), { added: 0, removed: 0 });
  await assert.rejects(f.sync.ensureServed("org", "app-a"), /being moved/);
  assert.deepEqual(f.calls, [], "no apply, no bounce, no register");
  assert.deepEqual(f.sync.replicatedApps.map((a) => a.appId), ["app-b"]);
});

test("reattach: replicated again through a BOUNCE, then promotions are allowed again", async () => {
  for (const detachFails of [false, true]) {
    const f = fixture({ detachFails });
    await f.sync.bootRestoreAll();
    f.sync.move.markDeparting("org", "app-a");
    await f.sync.move.detach("org", "app-a").catch(() => {});
    f.calls.length = 0;
    await f.sync.move.reattach("org", "app-a");
    assert.deepEqual(f.calls, ["bounce(app-a,app-b)"], `detachFails=${detachFails}`);
    await f.sync.ensureServed("org", "app-a");
  }
});

test("forget: no longer served, files set aside OUTSIDE the org's directory, deleted after the keep time", async () => {
  const f = fixture();
  await f.sync.bootRestoreAll();
  f.sync.move.markDeparting("org", "app-a");
  await f.sync.move.detach("org", "app-a");
  f.sync.move.forget("org", "app-a");
  assert.equal(f.sync.isServed("org", "app-a"), false);
  assert.equal(existsSync(dirname(f.dbPath("org", "app-a"))), false);
  const [kept] = readdirSync(join(f.dir, MOVED_DIR));
  assert.match(kept!, /^\d+__org__app-a$/);
  assert.equal(existsSync(join(f.dir, MOVED_DIR, kept!, "app.db")), true);
  assert.equal(sweepMoved(f.dir, 3_600_000), 0);
  assert.equal(sweepMoved(f.dir, 3_600_000, Date.now() + 3_600_001), 1);
  assert.deepEqual(readdirSync(join(f.dir, MOVED_DIR)), []);
});

test("arrival: a stale copy from an earlier stay is wiped; a copy that is being SERVED is never touched", async () => {
  const f = fixture();
  mkdirSync(dirname(f.dbPath("org", "app-z")), { recursive: true });
  writeFileSync(f.dbPath("org", "app-z"), "stale");
  await f.sync.move.clearForArrival("org", "app-z");
  assert.equal(existsSync(f.dbPath("org", "app-z")), false);
  await f.sync.bootRestoreAll();
  await assert.rejects(f.sync.move.clearForArrival("org", "app-a"), /already serves/);
  assert.equal(existsSync(f.dbPath("org", "app-a")), true);
});
