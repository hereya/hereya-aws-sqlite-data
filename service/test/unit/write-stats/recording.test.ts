// The hot path itself: what counts as a write, and what idleness it implies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteStats, statKey } from "../../../src/write-stats.ts";
import { fakeDdb, OPTS } from "./fake-ddb.ts";

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
