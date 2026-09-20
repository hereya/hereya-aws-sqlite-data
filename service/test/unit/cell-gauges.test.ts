// The cell's extra metrics (t_dbmove_p5_drain_ops): a stuck move, a lagging
// database, the relay's failures — each judged on THIS machine's clock or count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCellGauges } from "../../src/cell-gauges.ts";
import { maxLagSeconds } from "../../src/litestream/control.ts";
import type { MoveRow } from "../../src/move/record.ts";
import { StuckMoves } from "../../src/move/stuck.ts";

const row = (key: string, version: number): MoveRow => ({ key, vmId: "0", version, phase: "a_stopped", targetVm: "1" });

test("a move is stuck once the SAME move has been seen sweep after sweep", () => {
  const stuck = new StuckMoves(3);
  stuck.observe([row("o/a", 1)]);
  stuck.observe([row("o/a", 1)]);
  assert.equal(stuck.count, 0);
  stuck.observe([row("o/a", 1)]);
  assert.equal(stuck.count, 1);
  assert.deepEqual(stuck.keys, ["o/a#1"]);
});

test("a NEW move of the same app starts from zero, and a settled one is forgotten", () => {
  const stuck = new StuckMoves(2);
  stuck.observe([row("o/a", 1)]);
  stuck.observe([row("o/a", 3)]);
  assert.equal(stuck.count, 0, "version 3 is another move: a drain retrying is not a stuck move");
  stuck.observe([row("o/a", 3)]);
  assert.equal(stuck.count, 1);
  stuck.observe([]);
  assert.equal(stuck.count, 0);
});

test("lag = the OLDEST last sync; a database that never synced says nothing", () => {
  assert.equal(maxLagSeconds([{ lastSyncAtMs: 9_000 }, { lastSyncAtMs: 4_000 }, { lastSyncAtMs: null }], 10_000), 6);
  assert.equal(maxLagSeconds([{ lastSyncAtMs: null }], 10_000), null);
  assert.equal(maxLagSeconds([], 10_000), null);
  assert.equal(maxLagSeconds([{ lastSyncAtMs: 11_000 }], 10_000), 0);
});

test("relay counters are published per tick, not since boot", async () => {
  const stats = { forwarded: 0, failed: 0 };
  const gauges = createCellGauges({ replicationLagSeconds: async () => 2, stuckMoves: () => 0, relayStats: () => stats });
  stats.forwarded = 10;
  stats.failed = 1;
  const value = async (name: string) => (await gauges()).find((g) => g.name === name)?.value;
  assert.equal(await value("RelayedRequests"), 10);
  stats.forwarded = 14;
  assert.deepEqual([await value("RelayedRequests")], [4]);
  assert.equal(await value("RelayFailures"), 0);
});

test("one cell: no relay, no moves — only the lag is published", async () => {
  const gauges = createCellGauges({ replicationLagSeconds: async () => null, stuckMoves: null, relayStats: null });
  assert.deepEqual(await gauges(), [{ name: "ReplicationLagMaxSeconds", unit: "Seconds", value: null }]);
});
