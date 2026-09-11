// The durable half: which entries are written, and what a boot reads back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteStats, pendingSince, WRITE_STATS_PARTITION } from "../../../src/write-stats.ts";
import { fakeDdb, OPTS } from "./fake-ddb.ts";

test("only entries that MOVED are flushed", () => {
  // The write cost must follow real activity, not the number of apps hosted —
  // that is the whole point of the exercise.
  const stats = new Map([
    ["a", { lastWriteMs: 10, writes: 1, lastTouchMs: 10 }],
    ["b", { lastWriteMs: 20, writes: 1, lastTouchMs: 20 }],
  ]);
  assert.deepEqual(pendingSince(stats, new Map([["a", { lastWriteMs: 10, lastTouchMs: 10 }]])), ["b"]);
  assert.deepEqual(
    pendingSince(
      stats,
      new Map([
        ["a", { lastWriteMs: 10, lastTouchMs: 10 }],
        ["b", { lastWriteMs: 20, lastTouchMs: 20 }],
      ])
    ),
    []
  );
});

test("an entry whose TOUCH moved is flushed even though its write did not", () => {
  // The regression that would reintroduce t_3bdea3eeebb6 quietly: comparing
  // only lastWriteMs never persists a read-only app, so its touch would still
  // be lost on the next instance replacement and the flush would look healthy.
  const stats = new Map([["a", { lastWriteMs: 10, writes: 1, lastTouchMs: 999 }]]);
  assert.deepEqual(pendingSince(stats, new Map([["a", { lastWriteMs: 10, lastTouchMs: 10 }]])), ["a"]);
});

test("a flush persists into the fixed partition, and only once per change", async () => {
  const f = fakeDdb();
  const ws = new WriteStats({ ...OPTS, client: f.client as never, now: () => 4242 });
  ws.record("org", "app", 1);

  assert.equal(await ws.flush(), 1);
  assert.equal(f.updates[0]?.TableName, "reg");
  assert.deepEqual((f.updates[0]?.Key as Record<string, { S: string }>).org_id, { S: WRITE_STATS_PARTITION });
  assert.deepEqual((f.updates[0]?.Key as Record<string, { S: string }>).sk, { S: "org/app" });

  assert.equal(await ws.flush(), 0, "nothing moved, nothing written");
});

test("a failing flush never throws — a statistic must not break the service", async () => {
  const f = fakeDdb({ failUpdates: true });
  const ws = new WriteStats({ ...OPTS, client: f.client as never });
  ws.record("org", "app", 1);

  await assert.doesNotReject(() => ws.flush());
  // And the entry stays pending, so the next flush carries it again.
  assert.equal(pendingSince(ws.snapshot(), new Map()).length, 1);
});

test("history survives an instance replacement", async () => {
  // The failure this whole module exists to fix: a VM roll used to reset the
  // signal to "last boot".
  const f = fakeDdb({
    items: [{ sk: { S: "org/app" }, lastWriteMs: { N: "5000" }, writes: { N: "7" } }],
  });
  const ws = new WriteStats({ ...OPTS, client: f.client as never, now: () => 65_000 });

  assert.equal(await ws.load(), 1);
  assert.equal(ws.idleMsFor("org", "app"), 60_000, "idleness must count from BEFORE the restart");
  assert.equal(ws.snapshot().get("org/app")?.writes, 7);
});

test("a loaded entry is not re-flushed until it actually moves", async () => {
  const f = fakeDdb({
    items: [{ sk: { S: "org/app" }, lastWriteMs: { N: "5000" }, writes: { N: "7" } }],
  });
  const ws = new WriteStats({ ...OPTS, client: f.client as never, now: () => 9000 });
  await ws.load();

  assert.equal(await ws.flush(), 0, "a boot must not rewrite everything it just read");

  ws.record("org", "app", 1);
  assert.equal(await ws.flush(), 1);
});

test("malformed stored rows are skipped, not loaded as fresh writes", async () => {
  // A row with no timestamp read as 0 would make the app look infinitely idle;
  // read as now() it would look just-written. Both are wrong — skip it.
  const f = fakeDdb({
    items: [
      { sk: { S: "org/bad" }, writes: { N: "1" } },
      { sk: { S: "org/good" }, lastWriteMs: { N: "5000" }, writes: { N: "1" } },
    ],
  });
  const ws = new WriteStats({ ...OPTS, client: f.client as never });
  assert.equal(await ws.load(), 1);
  assert.equal(ws.idleMsFor("org", "bad"), null);
});
