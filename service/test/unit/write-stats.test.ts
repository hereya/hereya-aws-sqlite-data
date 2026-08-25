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
import {
  WriteStats,
  pendingSince,
  statKey,
  WRITE_STATS_PARTITION,
  OBSERVING_SINCE_KEY,
} from "../../src/write-stats.ts";

/**
 * DynamoDB stand-in that records commands and can be made to fail.
 *
 * It models `if_not_exists` for the observation date, because that is the whole
 * mechanism under test: the FIRST writer wins and every later one reads the
 * stored value back. A fake that echoed the caller's own timestamp would let a
 * broken implementation restart the clock on every boot and still pass.
 */
function fakeDdb(opts: { items?: Record<string, unknown>[]; failUpdates?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  let storedSince: string | null = null;
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      if (name === "QueryCommand") return { Items: opts.items ?? [] };
      if (opts.failUpdates) throw new Error("ddb down");
      updates.push(cmd.input);
      const key = cmd.input.Key as Record<string, { S: string }> | undefined;
      if (key?.sk?.S === OBSERVING_SINCE_KEY) {
        const proposed = (cmd.input.ExpressionAttributeValues as Record<string, { N: string }>)[":t"]!.N;
        storedSince ??= proposed;
        return { Attributes: { startedMs: { N: storedSince } } };
      }
      return {};
    },
  };
  return { client, updates, since: () => storedSince };
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

// --- dating the observation ------------------------------------------------
//
// "This app has never been seen writing" is only worth acting on if we know how
// long we have been looking. These pin that clock: it must start once, survive
// a VM roll, and stay null rather than guess.

test("the observation date is stamped once and never moved forward", async () => {
  const f = fakeDdb();
  let clock = 1_000;
  const first = new WriteStats({ ...OPTS, client: f.client as never, now: () => clock });

  assert.equal(await first.ensureObserving(), 1_000);
  assert.deepEqual(
    (f.updates[0]?.Key as Record<string, { S: string }>).org_id,
    { S: WRITE_STATS_PARTITION },
    "the date lives in the same fixed partition the instance role is scoped to",
  );
  assert.deepEqual((f.updates[0]?.Key as Record<string, { S: string }>).sk, { S: OBSERVING_SINCE_KEY });

  // A later boot — an instance replacement — must ADOPT the stored date, not
  // restart the clock. Restarting it is the exact failure that made the S3
  // timestamps useless, one level up.
  clock = 90 * 24 * 60 * 60 * 1000;
  const afterRoll = new WriteStats({ ...OPTS, client: f.client as never, now: () => clock });
  assert.equal(await afterRoll.ensureObserving(), 1_000, "a VM roll must not restart the observation");
  assert.equal(afterRoll.observedForMs(), clock - 1_000);
});

test("the stored date is picked up by load(), and is never mistaken for an app", async () => {
  // It shares the partition with the per-app rows. Every app key contains a
  // slash; this one does not — but the loader has to say so explicitly, or the
  // date would be counted as an app with no writes.
  const f = fakeDdb({
    items: [
      { sk: { S: OBSERVING_SINCE_KEY }, startedMs: { N: "5000" } },
      { sk: { S: "org/app" }, lastWriteMs: { N: "6000" }, writes: { N: "1" } },
    ],
  });
  const ws = new WriteStats({ ...OPTS, client: f.client as never, now: () => 65_000 });

  assert.equal(await ws.load(), 1, "the date is not an app");
  assert.equal(ws.observingSinceMs, 5_000);
  assert.equal(ws.observedForMs(), 60_000);
  assert.equal(ws.idleMsFor(OBSERVING_SINCE_KEY, ""), null);
});

test("a counter that cannot date itself reports null, not zero", async () => {
  // Zero would read as "watching since forever" and would make every unseen app
  // instantly evictable. Null is the only safe ignorance.
  const noTable = new WriteStats({ tableName: "", region: "eu-west-1" });
  assert.equal(await noTable.ensureObserving(), null);
  assert.equal(noTable.observedForMs(), null);

  const broken = new WriteStats({ ...OPTS, client: fakeDdb({ failUpdates: true }).client as never });
  await assert.doesNotReject(() => broken.ensureObserving(), "a statistic must never break a boot");
  assert.equal(broken.observedForMs(), null);
});

// --- The touch mark (t_3bdea3eeebb6) ---------------------------------------
//
// A second recency, answering a different question: writes decide WHO is an
// eviction candidate, touches decide who is still in use and must be spared.
// It lives here rather than in `AppSync` for one reason only — it has to
// survive an instance replacement, and process memory does not.

test("a read marks the app used WITHOUT inventing a write", () => {
  // The trap that would switch eviction off entirely: if a touch set
  // lastWriteMs, every app that is read would look freshly written and nothing
  // could ever become idle.
  const ws = new WriteStats({ ...OPTS, client: fakeDdb().client as never, now: () => 5000 });
  ws.recordTouch(statKey("org", "app"));

  assert.equal(ws.idleMsFor("org", "app"), null, "a read is not evidence about writing");
  assert.equal(ws.msSinceTouch(statKey("org", "app")), 0, "but it IS evidence about use");
  assert.equal(ws.snapshot().get(statKey("org", "app"))?.writes, 0);
});

test("a write also counts as an access", () => {
  const ws = new WriteStats({ ...OPTS, client: fakeDdb().client as never, now: () => 7000 });
  ws.record("org", "app", 1);
  assert.equal(ws.msSinceTouch(statKey("org", "app")), 0);
  assert.equal(ws.idleMsFor("org", "app"), 0);
});

test("an app nobody has ever touched reports null, which keeps it evictable", () => {
  const ws = new WriteStats({ ...OPTS, client: fakeDdb().client as never, now: () => 1 });
  assert.equal(ws.msSinceTouch(statKey("org", "ghost")), null);
});

test("the touch mark survives an instance replacement", async () => {
  // The whole point. Before this, `AppSync.lastTouch` was a plain Map, so the
  // `recently-served` guard was blind after every deploy — and there were 12
  // deploys on 2026-08-24 alone.
  const stored = fakeDdb({
    items: [{ sk: { S: "org/readonly" }, lastWriteMs: { N: "0" }, writes: { N: "0" }, lastTouchMs: { N: "900" } }],
  });
  const ws = new WriteStats({ ...OPTS, client: stored.client as never, now: () => 1000 });

  assert.equal(await ws.load(), 1, "a touch-only row is worth loading");
  assert.equal(ws.msSinceTouch("org/readonly"), 100, "the previous instance's access is still known");
  assert.equal(ws.idleMsFor("org", "readonly"), null, "and it still has never been seen writing");
});

test("a touch-only row is persisted, carrying a zero write stamp", async () => {
  const fake = fakeDdb();
  const ws = new WriteStats({ ...OPTS, client: fake.client as never, now: () => 4242 });
  ws.recordTouch("org/app");

  assert.equal(await ws.flush(), 1);
  const values = fake.updates[0]!.ExpressionAttributeValues as Record<string, { N: string }>;
  assert.equal(values[":u"]!.N, "4242", "the access is what moved");
  assert.equal(values[":t"]!.N, "0", "and no write is invented on the way to storage");
});

test("a row with neither half usable is skipped, not loaded as fresh activity", async () => {
  const stored = fakeDdb({
    items: [{ sk: { S: "org/empty" }, lastWriteMs: { N: "0" }, lastTouchMs: { N: "0" } }],
  });
  const ws = new WriteStats({ ...OPTS, client: stored.client as never, now: () => 1000 });
  assert.equal(await ws.load(), 0);
  assert.equal(ws.msSinceTouch("org/empty"), null);
});
