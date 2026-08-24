// Eviction: an app nobody writes stops being replicated.
//
// The economics are the easy half. What these tests exist for is the other
// half — the ways this feature could lose a customer's data without anyone
// noticing until a restore. Three of them, each pinned below:
//
//  1. evicting an app that is about to be written (open tx / in flight),
//  2. evicting on ignorance rather than on evidence of idleness,
//  3. a config write that disagrees with the replicated set, so an app is
//     believed watched and is not.
//
// The third is the subtle one and it is a RACE, so it is exercised by making
// a bounce hang and letting a promotion arrive underneath it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppSync } from "../../src/sync.ts";
import { daysToMs, planEviction, type EvictionProbe } from "../../src/eviction.ts";
import type { Litestream, LitestreamApp, RestoreOutcome } from "../../src/litestream.ts";
import type { Registry } from "../../src/registry.ts";
import type { AppManager } from "../../src/apps.ts";

const DAY = 24 * 60 * 60 * 1000;

function probeOf(
  idle: Record<string, number | null>,
  openTx: string[] = [],
  inFlight: Record<string, number> = {},
): EvictionProbe {
  return {
    idleMs: (key) => (key in idle ? idle[key]! : null),
    hasOpenTx: (key) => openTx.includes(key),
    inFlight: (key) => inFlight[key] ?? 0,
  };
}

// --- the pure planner ------------------------------------------------------

test("planEviction: evicts only what is provably idle past the threshold", () => {
  const keys = ["org/quiet", "org/busy"];
  const plan = planEviction(keys, probeOf({ "org/quiet": 40 * DAY, "org/busy": 2 * DAY }), 30 * DAY);
  assert.deepEqual(plan.evict, ["org/quiet"]);
  assert.equal(plan.skipped["recently-written"], 1);
});

test("planEviction: an app the counter has NEVER seen is not evictable", () => {
  // The counter's history starts when it shipped, so `null` means "we do not
  // know", not "idle forever". Evicting on absence of evidence would drop
  // replication for every app that simply predates the instrumentation — on
  // the very first sweep, for the whole fleet.
  const plan = planEviction(["org/unknown"], probeOf({}), 30 * DAY);
  assert.deepEqual(plan.evict, []);
  assert.equal(plan.skipped["never-observed"], 1);
});

test("planEviction: an open transaction or an in-flight statement protects an app", () => {
  const idle = { "org/tx": 90 * DAY, "org/busy": 90 * DAY, "org/free": 90 * DAY };
  const plan = planEviction(
    ["org/tx", "org/busy", "org/free"],
    probeOf(idle, ["org/tx"], { "org/busy": 1 }),
    30 * DAY,
  );
  // Both are idle by the clock, and both could write at any instant: a tx's
  // statements never re-enter ensureServed, and an in-flight one already passed it.
  assert.deepEqual(plan.evict, ["org/free"]);
  assert.equal(plan.skipped["open-tx"], 1);
  assert.equal(plan.skipped["in-flight"], 1);
});

test("planEviction: a non-positive threshold is the off switch", () => {
  const idle = { "org/ancient": 3650 * DAY };
  for (const threshold of [0, -1, Number.NaN]) {
    assert.deepEqual(planEviction(["org/ancient"], probeOf(idle), threshold).evict, [], `threshold ${threshold}`);
  }
  assert.equal(daysToMs(0), 0);
  assert.equal(daysToMs(30), 30 * DAY);
});

// --- the sync integration --------------------------------------------------

function fakeLitestream(opts: { onBounce?: (apps: LitestreamApp[]) => Promise<void> | void } = {}) {
  const configs: string[][] = [];
  const ls = {
    async restoreIfMissing(): Promise<RestoreOutcome> {
      return "restored";
    },
    async bounce(apps: LitestreamApp[]) {
      // Snapshot BEFORE any awaiting the hook does, exactly like the real
      // implementation writing the config file from its argument.
      const snapshot = apps.map((a) => a.appId).sort();
      await opts.onBounce?.(apps);
      configs.push(snapshot);
    },
  } as unknown as Litestream;
  return { ls, configs, lastConfig: () => configs[configs.length - 1] ?? null };
}

const manager = {
  dbPath: (o: string, a: string) => `/dbs/${o}/${a}/app.db`,
  async removeApp() {},
} as unknown as AppManager;

const registryOf = (ids: string[]) =>
  ({ listActive: async () => ids.map((appId) => ({ orgId: "org", appId })) }) as unknown as Registry;

test("an evicted app leaves the config but stays SERVED and readable", async () => {
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["quiet", "busy"]), manager, f.ls, 2);
  await sync.bootRestoreAll();
  assert.equal(sync.replicatedApps.length, 2);

  const plan = await sync.evictIdle(probeOf({ "org/quiet": 90 * DAY, "org/busy": 0 }), 30 * DAY);

  assert.deepEqual(plan.evict, ["org/quiet"]);
  assert.deepEqual(f.lastConfig(), ["busy"], "the config must no longer mention the evicted app");
  // The point of the whole design: nothing was torn down. The app answers
  // reads with no wake-up, and its file was never touched.
  assert.equal(sync.servedApps.length, 2, "an evicted app is still served");
  assert.equal(sync.isServed("org", "quiet"), true);
  assert.equal(sync.unusedCount, 1);
});

test("one bounce for the whole batch, and none at all when nothing is evictable", async () => {
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["a", "b", "c", "d"]), manager, f.ls, 4);
  await sync.bootRestoreAll();
  const before = f.configs.length;

  const idle = { "org/a": 90 * DAY, "org/b": 90 * DAY, "org/c": 90 * DAY, "org/d": 1 };
  await sync.evictIdle(probeOf(idle), 30 * DAY);
  assert.equal(f.configs.length - before, 1, "three evictions must cost ONE config rewrite");
  assert.deepEqual(f.lastConfig(), ["d"]);

  // A sweep that finds nothing must not bounce: a bounce suspends replication
  // for every OTHER app on this VM (one litestream process), so an idle sweep
  // that keeps bouncing would tax the whole fleet hourly for no reason.
  const after = f.configs.length;
  await sync.evictIdle(probeOf(idle), 30 * DAY);
  assert.equal(f.configs.length, after, "a no-op sweep must not touch the config");
});

test("a write brings an evicted app back BEFORE the statement can run", async () => {
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["quiet"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  await sync.evictIdle(probeOf({ "org/quiet": 90 * DAY }), 30 * DAY);
  assert.deepEqual(f.lastConfig(), []);

  // This is the call every data route awaits in `authorize()`.
  await sync.ensureServed("org", "quiet");

  assert.deepEqual(f.lastConfig(), ["quiet"], "the app must be back in the config once ensureServed resolves");
  assert.equal(sync.unusedCount, 0);
});

test("an app a request was just cleared for is NOT evicted behind its back", async () => {
  // The window that no other guard can see. `ensureServed` returns early when
  // the app is already replicated, and `server.ts` acquires the limiter slot
  // only AFTER that returns — so for a moment the statement is authorised to
  // write while `inFlight` is 0 and no tx is open. A sweep landing there would
  // evict a database that is about to be written.
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["quiet"]), manager, f.ls, 1);
  await sync.bootRestoreAll();

  // Exactly the sequence `authorize()` produces, with the sweep in the gap.
  const cleared = sync.ensureServed("org", "quiet");
  const plan = await sync.evictIdle(probeOf({ "org/quiet": 90 * DAY }), 30 * DAY);
  await cleared;

  assert.deepEqual(plan.evict, [], "an app cleared to run moments ago must not be evictable");
  assert.deepEqual(
    sync.replicatedApps.map((a) => a.appId),
    ["quiet"],
    "the app the request was cleared for must still be watched",
  );
  // And nothing was published that omitted it — the config never disagreed.
  assert.ok(
    f.configs.every((c) => c.includes("quiet")),
    "no published config may omit an app that stayed replicated",
  );
});

test("two config writers cannot publish disagreeing configs", async () => {
  // The lock's own property, tested where the touch grace cannot mask it: the
  // evicted app and the promoted app are DIFFERENT. Without serialization the
  // eviction's snapshot (taken before the promotion joined the set) can be
  // written last, publishing a config that omits an app `replicated` believes
  // is watched — an app answering writes nobody is replicating.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstBounce = false;
  const f = fakeLitestream({
    onBounce: async () => {
      if (firstBounce) {
        firstBounce = false;
        await gate; // hold the eviction's config write open
      }
    },
  });
  const sync = new AppSync(registryOf(["stale"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  firstBounce = true;

  const eviction = sync.evictIdle(probeOf({ "org/stale": 90 * DAY }), 30 * DAY);
  const promotion = sync.ensureServed("org", "newcomer"); // hot-add, a different app

  release!();
  await Promise.all([eviction, promotion]);

  const replicated = sync.replicatedApps.map((a) => a.appId).sort();
  assert.deepEqual(replicated, ["newcomer"], "the evicted app leaves, the promoted one joins");
  assert.deepEqual(
    f.lastConfig(),
    replicated,
    "the config published last must agree with the replicated set",
  );
});

test("an app mid-promotion is never evicted out from under the request waiting on it", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fakeLitestream();
  const slowManager = {
    dbPath: (o: string, a: string) => `/dbs/${o}/${a}/app.db`,
    async removeApp() {},
  } as unknown as AppManager;
  const sync = new AppSync(registryOf([]), slowManager, f.ls, 1);
  await sync.bootRestoreAll();

  // A hot-add whose restore is still running: `pending` holds its promise.
  const slowLs = {
    async restoreIfMissing() {
      await gate;
      return "restored" as RestoreOutcome;
    },
    bounce: f.ls.bounce.bind(f.ls),
  } as unknown as Litestream;
  const sync2 = new AppSync(registryOf([]), slowManager, slowLs, 1);
  const promotion = sync2.ensureServed("org", "newcomer");

  const plan = await sync2.evictIdle(probeOf({ "org/newcomer": 90 * DAY }), 30 * DAY);
  assert.deepEqual(plan.evict, [], "an app being promoted must not be a candidate");

  release!();
  await promotion;
  assert.equal(sync2.replicatedApps.length, 1);
  void sync;
});
