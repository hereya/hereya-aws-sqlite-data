import assert from "node:assert/strict";
import { test } from "node:test";
import { AppSync } from "../../../src/sync.ts";
import { DAY, fakeLitestream, manager, probeOf, registryOf } from "./helpers.ts";

// --- the touch mark across an instance replacement (t_3bdea3eeebb6) --------
//
// `AppSync.lastTouch` is process memory, so a fresh instance starts with none.
// The `recently-served` guard compares it against a threshold measured in DAYS,
// which meant that after every deploy an app that is READ constantly and never
// written was a candidate with no veto. The durable sink closes that; these
// tests pin both halves — that the veto now crosses a restart, and that it
// still cannot invent one for an app nobody has touched.

/** A `TouchSink` stand-in: what the previous instance had flushed. */
function sinkOf(persisted: Record<string, number>, now = 0) {
  const seen = new Map<string, number>(Object.entries(persisted));
  return {
    recorded: [] as string[],
    recordTouch(key: string, atMs: number) {
      seen.set(key, atMs);
      this.recorded.push(key);
    },
    msSinceTouch(key: string): number | null {
      const at = seen.get(key);
      return at === undefined ? null : Math.max(0, now - at);
    },
  };
}

test("a read-only app is spared after a restart, because the touch mark is durable", async () => {
  // The regression this whole task exists for. `org/vitrine` is a showcase
  // site: read all day, never written. A fresh instance has no memory of it.
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["vitrine"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  // Flushed by the PREVIOUS instance an hour ago. Deliberately well outside
  // the 5-minute `EVICT_TOUCH_GRACE_MS` window, so what spares this app is the
  // `recently-served` guard reading the durable mark — not the grace filter,
  // which would pass this test without the guard ever being consulted.
  sync.setTouchSink(sinkOf({ "org/vitrine": 0 }, 60 * 60 * 1000));

  // Never seen writing, and observed for long enough that ignorance has
  // matured into evidence — so it IS a candidate on the write axis.
  const configsBefore = f.configs.length;
  const plan = await sync.evictIdle(probeOf({ "org/vitrine": null }, [], {}, 90 * DAY), 30 * DAY);

  assert.deepEqual(plan.evict, [], "an app read an hour ago must not be evicted");
  assert.equal(plan.skipped["recently-served"], 1, "and the veto must be the reason");
  // And no bounce at all: a sweep that frees nothing must not suspend
  // replication for every OTHER app on the VM.
  assert.deepEqual(
    sync.replicatedApps.map((a) => a.appId),
    ["vitrine"],
    "the app must still be replicated"
  );
  assert.equal(f.configs.length, configsBefore, "and the config must not be rewritten");
});

test("without the durable mark the same app WOULD be evicted — the guard is what changed", async () => {
  // The negative. Same instance, same probe, no sink: this is the behaviour
  // before the fix, and it must still be reachable or the test above proves
  // nothing.
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["vitrine"]), manager, f.ls, 1);
  await sync.bootRestoreAll();

  const plan = await sync.evictIdle(probeOf({ "org/vitrine": null }, [], {}, 90 * DAY), 30 * DAY);

  assert.deepEqual(plan.evict, ["org/vitrine"]);
});

test("a stale persisted mark does NOT veto — it only spares apps genuinely in use", async () => {
  // Durability must not become immortality: an app last touched long before the
  // threshold is still evictable, otherwise persisting the mark would quietly
  // switch eviction off for every app that ever answered one request.
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["abandoned"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  sync.setTouchSink(sinkOf({ "org/abandoned": 0 }, 90 * DAY));

  const plan = await sync.evictIdle(probeOf({ "org/abandoned": null }, [], {}, 90 * DAY), 30 * DAY);

  assert.deepEqual(plan.evict, ["org/abandoned"]);
});

test("live memory wins over the store, and every access is reported to it", async () => {
  const f = fakeLitestream();
  const sync = new AppSync(registryOf(["app"]), manager, f.ls, 1);
  await sync.bootRestoreAll();
  // The store believes this app has not been touched for 90 days...
  const sink = sinkOf({ "org/app": 0 }, 90 * DAY);
  sync.setTouchSink(sink);

  // ...but it was just used, and `ensureServed` is what says so.
  await sync.ensureServed("org", "app");
  assert.ok(sink.recorded.includes("org/app"), "the access must reach the durable store too");

  const plan = await sync.evictIdle(probeOf({ "org/app": null }, [], {}, 90 * DAY), 30 * DAY);
  assert.deepEqual(plan.evict, [], "the fresher in-memory mark must win");
});
