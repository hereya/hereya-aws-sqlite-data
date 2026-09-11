// Eviction, the pure planner: which apps a sweep may drop, and — far more
// important — which it must not. Two of the three ways this feature could lose
// a customer's data without anyone noticing until a restore are pinned here:
//
//  1. evicting an app that is about to be written (open tx / in flight),
//  2. evicting on ignorance rather than on evidence of idleness.
//
// The third (a config write that disagrees with the replicated set) is a RACE
// and lives with the `AppSync` integration tests, in `sync.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daysToMs, planEviction } from "../../../src/eviction.ts";
import { DAY, probeOf } from "./helpers.ts";

// --- the pure planner ------------------------------------------------------
test("planEviction: evicts only what is provably idle past the threshold", () => {
  const keys = ["org/quiet", "org/busy"];
  const plan = planEviction(keys, probeOf({ "org/quiet": 40 * DAY, "org/busy": 2 * DAY }), 30 * DAY);
  assert.deepEqual(plan.evict, ["org/quiet"]);
  assert.equal(plan.skipped["recently-written"], 1);
});

test("planEviction: an app the counter has NEVER seen is not evictable YET", () => {
  // The counter's history starts when it shipped, so early on `null` means "we
  // do not know", not "idle forever". Evicting on absence of evidence would
  // drop replication for every app that simply predates the instrumentation —
  // on the very first sweep, for the whole fleet.
  for (const observed of [null, 0, 1 * DAY, 29 * DAY, 30 * DAY]) {
    const plan = planEviction(["org/unknown"], probeOf({}, [], {}, observed), 30 * DAY);
    assert.deepEqual(plan.evict, [], `observed for ${observed}`);
    assert.equal(plan.skipped["never-observed"], 1);
    assert.equal(plan.evictedUnobserved, 0);
  }
});

test("planEviction: once the observation OUTLASTS the threshold, never-seen means idle", () => {
  // The end of the rule above, and the reason this exists: an app that never
  // writes at all is the one that costs the VM the most, and under the naive
  // rule it could never be evicted. After watching for longer than the window
  // we ourselves call "idle", silence stops being ignorance.
  const plan = planEviction(["org/inert"], probeOf({}, [], {}, 31 * DAY), 30 * DAY);
  assert.deepEqual(plan.evict, ["org/inert"]);
  assert.equal(plan.skipped["never-observed"], 0);
  assert.equal(plan.evictedUnobserved, 1, "the log must be able to say this came from the new rule");
});

test("planEviction: a mature observation does NOT weaken any other guard", () => {
  // Admitting an app on "never seen writing" changes only which apps reach the
  // guards — never what the guards decide. A recent write, an open tx and an
  // in-flight statement each still win.
  const plan = planEviction(
    ["org/inert", "org/tx", "org/busy", "org/fresh"],
    probeOf({ "org/fresh": 1 * DAY }, ["org/tx"], { "org/busy": 1 }, 400 * DAY),
    30 * DAY,
  );
  assert.deepEqual(plan.evict, ["org/inert"]);
  assert.equal(plan.skipped["open-tx"], 1);
  assert.equal(plan.skipped["in-flight"], 1);
  assert.equal(plan.skipped["recently-written"], 1);
});

test("planEviction: an app still being SERVED is not idle, however long ago it wrote", () => {
  // The cost this closes: `ensureServed` promotes on any access, reads
  // included, and every promotion bounces litestream for the whole fleet. An
  // app that is read hourly but never written would otherwise be evicted and
  // re-promoted hourly, forever — the population the maturity rule admits
  // first. Write-idle is not the same thing as unused.
  const plan = planEviction(
    ["org/read-only", "org/truly-inert"],
    probeOf({}, [], {}, 400 * DAY, { "org/read-only": 2 * DAY }),
    30 * DAY,
  );
  assert.deepEqual(plan.evict, ["org/truly-inert"]);
  assert.equal(plan.skipped["recently-served"], 1);
});

test("planEviction: served long ago is evictable, and never served at all still is", () => {
  // Null must stay evictable: it is what EVERY app looks like on a fresh
  // instance, and treating it as protection would restart the clock on every
  // deploy — a fleet that rolls weekly would never evict anything.
  const plan = planEviction(
    ["org/stale-touch", "org/untouched"],
    probeOf({ "org/stale-touch": 90 * DAY }, [], {}, 400 * DAY, { "org/stale-touch": 60 * DAY }),
    30 * DAY,
  );
  assert.deepEqual(plan.evict.sort(), ["org/stale-touch", "org/untouched"]);
  assert.equal(plan.skipped["recently-served"], 0);
});

test("planEviction: a counter that cannot date itself evicts nothing on ignorance", () => {
  // `observedForMs === null` is the failure mode of the DynamoDB stamp (no
  // table, no permission, a failed call). It must read as "we do not know",
  // never as "forever" — that direction keeps apps replicated.
  const plan = planEviction(["org/a", "org/b"], probeOf({}, [], {}, null), 30 * DAY);
  assert.deepEqual(plan.evict, []);
  assert.equal(plan.skipped["never-observed"], 2);
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
