// --- The touch mark (t_3bdea3eeebb6) ---------------------------------------
//
// A second recency, answering a different question: writes decide WHO is an
// eviction candidate, touches decide who is still in use and must be spared.
// It lives here rather than in `AppSync` for one reason only — it has to
// survive an instance replacement, and process memory does not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteStats, statKey } from "../../../src/write-stats.ts";
import { fakeDdb, OPTS } from "./fake-ddb.ts";

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
