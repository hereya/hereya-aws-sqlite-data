// An app that has never been written is served but NOT replicated.
//
// Why this is safe, and why that reasoning has to be pinned by tests: a `fresh`
// app holds NO DATA. Not replicating it risks nothing — unlike evicting an app
// that HAS data, which is a different and genuinely dangerous design. What the
// tests below guard is the one place that could still lose a write: the
// promotion must happen BEFORE any statement runs. `authorize()` calls
// `ensureServed` ahead of every data route, so the ordering holds by
// construction — these tests make sure the pieces underneath keep their end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppSync } from "../../src/sync.ts";
import type { Litestream, LitestreamApp, RestoreOutcome } from "../../src/litestream.ts";
import type { Registry } from "../../src/registry.ts";
import type { AppManager } from "../../src/apps.ts";

/** Litestream stand-in that reports a chosen outcome and records every config. */
function fakeLitestream(outcomeFor: (appId: string) => RestoreOutcome) {
  const bounces: string[][] = [];
  const restored: string[] = [];
  const ls = {
    async restoreIfMissing(app: LitestreamApp) {
      restored.push(app.appId);
      return outcomeFor(app.appId);
    },
    async bounce(apps: LitestreamApp[]) {
      bounces.push(apps.map((a) => a.appId).sort());
    },
  } as unknown as Litestream;
  return { ls, bounces, restored, lastConfig: () => bounces[bounces.length - 1] ?? null };
}

function fakeRegistry(ids: string[]): Registry {
  return { listActive: async () => ids.map((appId) => ({ orgId: "org", appId })) } as unknown as Registry;
}

const manager = { dbPath: (o: string, a: string) => `/dbs/${o}/${a}/app.db` } as unknown as AppManager;

test("a never-written app is served but kept OUT of the litestream config", async () => {
  // app-b has a replica (restored), app-a and app-c never wrote anything.
  const f = fakeLitestream((id) => (id === "app-b" ? "restored" : "fresh"));
  const sync = new AppSync(fakeRegistry(["app-a", "app-b", "app-c"]), manager, f.ls, 4);

  const replicated = await sync.bootRestoreAll();

  assert.equal(sync.servedApps.length, 3, "all three must be servable");
  assert.deepEqual(replicated.map((a) => a.appId), ["app-b"], "only the one with data is replicated");
  assert.equal(sync.unusedCount, 2);
});

test("an existing app is replicated from the start — 'existing' is not 'fresh'", async () => {
  // A service restart finds local files already present. Those apps HAVE data;
  // treating them like never-written ones would stop replicating live data.
  const f = fakeLitestream(() => "existing");
  const sync = new AppSync(fakeRegistry(["app-a", "app-b"]), manager, f.ls, 2);

  const replicated = await sync.bootRestoreAll();

  assert.equal(replicated.length, 2, "existing local data must never be left unreplicated");
  assert.equal(sync.unusedCount, 0);
});

test("touching an unused app PROMOTES it, and the config gains it", async () => {
  const f = fakeLitestream(() => "fresh");
  const sync = new AppSync(fakeRegistry(["app-a"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  assert.equal(sync.replicatedApps.length, 0);

  await sync.ensureServed("org", "app-a");

  assert.deepEqual(sync.replicatedApps.map((a) => a.appId), ["app-a"]);
  assert.deepEqual(f.lastConfig(), ["app-a"], "litestream must be reconfigured, not just bookkept");
});

test("promotion does NOT re-restore — the local file is already the truth", async () => {
  // Restoring again over a file that exists is exactly the stale-data trap
  // invariant 2 exists to prevent.
  const f = fakeLitestream(() => "fresh");
  const sync = new AppSync(fakeRegistry(["app-a"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  const afterBoot = f.restored.length;

  await sync.ensureServed("org", "app-a");

  assert.equal(f.restored.length, afterBoot, "promotion must not call restore again");
});

test("a promoted app is not promoted twice", async () => {
  const f = fakeLitestream(() => "fresh");
  const sync = new AppSync(fakeRegistry(["app-a"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  await sync.ensureServed("org", "app-a");
  const bouncesAfterFirst = f.bounces.length;

  await sync.ensureServed("org", "app-a");

  assert.equal(f.bounces.length, bouncesAfterFirst, "the hot path must cost nothing once replicated");
});

test("concurrent first requests promote once, not once each", async () => {
  const f = fakeLitestream(() => "fresh");
  const sync = new AppSync(fakeRegistry(["app-a"]), manager, f.ls, 1);
  await sync.bootRestoreAll();

  await Promise.all([
    sync.ensureServed("org", "app-a"),
    sync.ensureServed("org", "app-a"),
    sync.ensureServed("org", "app-a"),
  ]);

  assert.equal(f.bounces.length, 1, "the per-app mutex must collapse the race");
  assert.equal(sync.replicatedApps.length, 1);
});

test("a failed promotion leaves the app SERVED and unreplicated, never half-registered", async () => {
  // The app was already answering queries before this call; a bounce failure
  // must not take that away from it.
  const f = fakeLitestream(() => "fresh");
  const sync = new AppSync(fakeRegistry(["app-a"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  (f.ls as unknown as { bounce: () => Promise<void> }).bounce = async () => {
    throw new Error("boom");
  };

  await assert.rejects(() => sync.ensureServed("org", "app-a"));

  assert.equal(sync.servedApps.length, 1, "an already-serving app must keep serving");
  assert.equal(sync.replicatedApps.length, 0, "and must not be recorded as replicated");
});

test("removing an unused app does not bounce — there was nothing to reconfigure", async () => {
  const f = fakeLitestream(() => "fresh");
  const sync = new AppSync(fakeRegistry(["app-a"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  const managerWithRemove = manager as unknown as { removeApp?: unknown };
  managerWithRemove.removeApp = async () => {};
  const before = f.bounces.length;

  await sync.removeApp("org", "app-a");

  assert.equal(f.bounces.length, before, "dropping an unwatched app changes nothing litestream sees");
});
