// The handover protocol's safety properties (t_vm_zero_cut_handover).
//
// This is the most dangerous code in the package: it deliberately creates the
// state the ASG exists to prevent — two instances alive at once — so what is
// pinned here is not "does it work" but "can it ever let both write".
//
// The properties, in the order they matter:
//   1. Ordering NEVER compares two machines' clocks. The report is one durable
//      item reused by every roll, so it needs an ordering signal; `seq` is one,
//      a timestamp written by the OTHER machine is not.
//   2. An unreadable store reads as "no proof", never as permission.
//   3. A timeout is its own outcome, never disguised as success.
//   4. The catch-up window is dated on ONE clock — the departing instance's —
//      and an instance that could not date it says UNKNOWN rather than
//      claiming nothing changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  announceWarming,
  awaitHandover,
  observeWarming,
  publishHandover,
} from "../service/src/handover/protocol.ts";
import { supersedes, type HandoverRecord } from "../service/src/handover/record.ts";
import { dirtySince, snapshotWrites, splitAppKey } from "../service/src/handover/dirty.ts";
import type { WriteStat } from "../service/src/write-stats/stat.ts";

/** A DynamoDB stand-in holding items by sort key, or failing on demand. */
function fakeDdb(opts: { fail?: boolean } = {}) {
  const items = new Map<string, Record<string, unknown>>();
  return {
    items,
    client: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (opts.fail) throw new Error("dynamodb unavailable");
        const src = (cmd.constructor.name === "PutItemCommand" ? cmd.input.Item : cmd.input.Key) as
          Record<string, { S?: string } | undefined>;
        const key = src.sk?.S ?? "";
        if (cmd.constructor.name === "PutItemCommand") {
          items.set(key, cmd.input.Item as Record<string, unknown>);
          return {};
        }
        return { Item: items.get(key) };
      },
    } as never,
    tableName: "registry",
  };
}

const stat = (writes: number, lastWriteMs = 0): WriteStat => ({ lastWriteMs, writes, lastTouchMs: lastWriteMs });

test("ordering is by seq, so no two machines' clocks are ever compared", () => {
  const baseline: HandoverRecord = { seq: 7, fromInstanceId: "i-old", atMs: 9_999_999, dirtyApps: [] };
  // The successor's `atMs` is EARLIER than the baseline's — a clock running
  // behind on the next departing instance, or simply a different machine. The
  // old `atMs > warmStart` test would have rejected this genuine handover and
  // timed out; seq accepts it.
  assert.equal(supersedes(baseline, { seq: 8, fromInstanceId: "i-new", atMs: 1, dirtyApps: [] }), true);
  // And the dangerous direction: a LATER wall clock does not make an old
  // report count.
  assert.equal(supersedes(baseline, { seq: 7, fromInstanceId: "i-old", atMs: 99_999_999, dirtyApps: [] }), false);
  assert.equal(supersedes(baseline, { seq: 6, fromInstanceId: "i-older", atMs: 99_999_999, dirtyApps: [] }), false);
  // No baseline (first roll ever) — any report counts.
  assert.equal(supersedes(null, { seq: 1, fromInstanceId: "i", atMs: 0, dirtyApps: [] }), true);
  assert.equal(supersedes(null, null), false);
});

test("a report from a PREVIOUS roll makes the replacement wait, then time out", async () => {
  // The exact trap: one durable item survives every handover, so a replacement
  // that did not baseline would read a months-old stop and start writing while
  // the current instance still is.
  const store = fakeDdb();
  let clock = 1_000;
  const deps = { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) };
  await publishHandover(deps, { instanceId: "i-from-last-month", dirtyApps: [] });

  clock = 50_000;
  const baseline = await announceWarming(deps, { instanceId: "i-new" });
  assert.equal(baseline?.seq, 1, "the baseline is the report as it stood at warm start");
  const outcome = await awaitHandover(deps, { baseline, timeoutMs: 2_000 });
  assert.equal(outcome.reason, "timeout");
});

test("an unreadable store is 'no proof', not permission", async () => {
  const store = fakeDdb({ fail: true });
  let clock = 0;
  const outcome = await awaitHandover(
    { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) },
    { baseline: null, timeoutMs: 1_500 },
  );
  assert.equal(outcome.reason, "timeout", "a read failure must never resolve as a handover");
});

test("the full sequence: announce, observe, publish, observe the stop", async () => {
  const store = fakeDdb();
  let clock = 10_000;
  const deps = { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) };

  // The replacement announces and takes its baseline.
  const baseline = await announceWarming(deps, { instanceId: "i-new" });
  assert.equal(baseline, null, "no previous roll");

  // The departing instance observes the announcement, on ITS OWN clock.
  clock = 10_200;
  const windowStart = await observeWarming(deps, { selfInstanceId: "i-old" });
  assert.equal(windowStart, 10_200);

  // …and never mistakes its own announcement for a replacement's.
  assert.equal(await observeWarming(deps, { selfInstanceId: "i-new" }), null);

  // It drains, stops litestream, then reports what moved during the window.
  clock = 10_400;
  await publishHandover(deps, { instanceId: "i-old", dirtyApps: ["org-a/app-1"] });

  clock = 10_500;
  const outcome = await awaitHandover(deps, { baseline, timeoutMs: 5_000 });
  assert.equal(outcome.reason, "handover");
  if (outcome.reason !== "handover") return;
  assert.equal(outcome.record.seq, 1);
  assert.deepEqual(outcome.record.dirtyApps, ["org-a/app-1"]);
  assert.equal(outcome.record.dirtyUnknown, false);
});

test("an instance that could not date the window says UNKNOWN, never 'nothing changed'", async () => {
  const store = fakeDdb();
  let clock = 1_000;
  const deps = { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) };
  await publishHandover(deps, { instanceId: "i-old", dirtyApps: null });
  clock = 1_100;
  const outcome = await awaitHandover(deps, { baseline: null, timeoutMs: 100 });
  assert.equal(outcome.reason, "handover");
  if (outcome.reason !== "handover") return;
  // Claiming an empty list here would make the replacement skip the catch-up
  // and serve a stale database — the one silent-data-loss shape in this design.
  assert.equal(outcome.record.dirtyUnknown, true);
});

test("seq increments from what is stored, so a backwards clock cannot rewind it", async () => {
  const store = fakeDdb();
  let clock = 5_000;
  const deps = { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) };
  await publishHandover(deps, { instanceId: "i-1", dirtyApps: [] });
  // The next instance's clock has jumped BACKWARDS by an hour.
  await publishHandover({ ...deps, now: () => 5_000 - 3_600_000 }, { instanceId: "i-2", dirtyApps: [] });
  clock = 6_000;
  const outcome = await awaitHandover(deps, {
    baseline: { seq: 1, fromInstanceId: "i-1", atMs: 5_000, dirtyApps: [] },
    timeoutMs: 100,
  });
  assert.equal(outcome.reason, "handover");
  if (outcome.reason !== "handover") return;
  assert.equal(outcome.record.seq, 2, "the counter moved forward even though the clock moved back");
});

test("publishing never throws, so a dying instance still dies cleanly", async () => {
  const store = fakeDdb({ fail: true });
  const ok = await publishHandover(
    { client: store.client, tableName: store.tableName, now: () => 1 },
    { instanceId: "i-old", dirtyApps: [] },
  );
  assert.equal(ok, false, "it reports failure rather than raising it into the shutdown path");
});

test("the catch-up list is COUNTED, not timed — no clock can change the answer", () => {
  // The window opens: snapshot what the counter holds.
  const stats = new Map<string, WriteStat>([
    // A row seeded from DynamoDB by a PREVIOUS instance, whose lastWriteMs is
    // on that machine's clock and is deliberately in the FUTURE of ours. A
    // timestamp comparison would call it dirty; its count never moves, so it
    // is not.
    ["org/seeded-future", stat(4, 9_999_999_999)],
    ["org/quiet", stat(7, 500)],
    ["org/busy", stat(2, 500)],
    ["org/read-only", stat(0, 0)],
  ]);
  const snapshot = snapshotWrites(stats);

  // …the window runs. Only these two actually change the database.
  stats.set("org/busy", stat(3, 1_500));
  stats.set("org/new-app", stat(1, 1_400)); // first written during the window
  // A read-only app is touched but never written: its count stays 0.
  stats.set("org/read-only", { lastWriteMs: 0, writes: 0, lastTouchMs: 9_000 });
  // And a local clock that STEPPED BACKWARDS during the window: the write is
  // real and stamped earlier than the window opened. Timed logic would drop
  // it — the data-loss direction. Counted logic keeps it.
  stats.set("org/quiet", stat(8, 1));

  assert.deepEqual(dirtySince(snapshot, stats), ["org/busy", "org/new-app", "org/quiet"]);
});

test("an app that vanished from the counter is not resurrected into the list", () => {
  const stats = new Map<string, WriteStat>([["org/gone", stat(3)], ["org/stays", stat(1)]]);
  const snapshot = snapshotWrites(stats);
  stats.delete("org/gone"); // the app was dropped while we drained
  assert.deepEqual(dirtySince(snapshot, stats), []);
});

test("app keys round-trip, and a malformed one is refused rather than guessed", () => {
  assert.deepEqual(splitAppKey("11111111-2222-3333-4444-555555555555/app-9"), {
    orgId: "11111111-2222-3333-4444-555555555555",
    appId: "app-9",
  });
  assert.equal(splitAppKey("no-slash"), null);
  assert.equal(splitAppKey("/leading"), null);
  assert.equal(splitAppKey("trailing/"), null);
});
