// Per-app write recency. Two things are being guarded here, and only one of
// them is "does it count correctly":
//
//  1. It sits on the write path. It must never be able to fail a customer's
//     write — no I/O, no throw, no await on the hot path.
//  2. It must survive an instance replacement. Losing history on every deploy
//     is exactly what made the replica-bucket timestamps useless (four VM rolls
//     on 2026-08-24 erased the signal four times).
import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteStats, pendingSince, statKey, WRITE_STATS_PARTITION } from "../../src/write-stats.ts";

/** DynamoDB stand-in that records commands and can be made to fail. */
function fakeDdb(opts: { items?: Record<string, unknown>[]; failUpdates?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      if (name === "QueryCommand") return { Items: opts.items ?? [] };
      if (opts.failUpdates) throw new Error("ddb down");
      updates.push(cmd.input);
      return {};
    },
  };
  return { client, updates };
}

const OPTS = { tableName: "reg", region: "eu-west-1" };

test("only a statement that CHANGED the database counts", () => {
  // Same definition litestream reacts to: zero rows touched = no LTX file = no
  // replication cost, so counting it would measure the wrong thing.
  const ws = new WriteStats({ ...OPTS, client: fakeDdb().client as never, now: () => 1000 });
  ws.record("org", "app", 0);
  ws.record("org", "app", -1);
  assert.equal(ws.snapshot().size, 0, "a no-op statement is not a write");

  ws.record("org", "app", 3);
  assert.equal(ws.snapshot().get(statKey("org", "app"))?.writes, 1);
});

test("the hot path is synchronous and cannot throw", () => {
  // No client at all, no table: record() must still be safe to call from
  // inside a customer's write.
  const ws = new WriteStats({ tableName: "", region: "eu-west-1" });
  assert.doesNotThrow(() => ws.record("org", "app", 1));
  assert.equal(ws.idleMsFor("org", "app") !== null, true);
});

test("recency advances, and idle time is measured from the last change", () => {
  let clock = 1_000;
  const ws = new WriteStats({ ...OPTS, client: fakeDdb().client as never, now: () => clock });
  ws.record("org", "app", 1);
  clock = 61_000;
  assert.equal(ws.idleMsFor("org", "app"), 60_000);

  ws.record("org", "app", 1);
  assert.equal(ws.idleMsFor("org", "app"), 0, "a new write resets the idleness");
  assert.equal(ws.snapshot().get(statKey("org", "app"))?.writes, 2);
});

test("an app never written reports null, not zero", () => {
  // Zero would read as "just written" — the opposite of the truth, and it would
  // keep an idle app out of any eviction set.
  const ws = new WriteStats({ ...OPTS, client: fakeDdb().client as never });
  assert.equal(ws.idleMsFor("org", "never"), null);
});

test("only entries that MOVED are flushed", () => {
  // The write cost must follow real activity, not the number of apps hosted —
  // that is the whole point of the exercise.
  const stats = new Map([
    ["a", { lastWriteMs: 10, writes: 1 }],
    ["b", { lastWriteMs: 20, writes: 1 }],
  ]);
  assert.deepEqual(pendingSince(stats, new Map([["a", 10]])), ["b"]);
  assert.deepEqual(pendingSince(stats, new Map([["a", 10], ["b", 20]])), []);
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
