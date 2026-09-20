// The operator's side of a drain (t_dbmove_p5_drain_ops): which orders are
// refused, and what the routes accept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DrainAdmin } from "../../src/drain/admin.ts";
import type { DrainOrder, DrainProgress, DrainStore } from "../../src/drain/store.ts";
import { parseDrainCell, parseDrainStatus } from "../../src/server/drain-routes.ts";
import type { VmRow } from "../../src/vms.ts";

function memoryStore(): DrainStore & { orders: Map<string, DrainOrder>; progress: Map<string, DrainProgress> } {
  const orders = new Map<string, DrainOrder>();
  const progress = new Map<string, DrainProgress>();
  return {
    orders,
    progress,
    readOrder: async (cell) => orders.get(cell) ?? null,
    putOrder: async (o) => void orders.set(o.cellId, o),
    deleteOrder: async (cell) => void orders.delete(cell),
    readProgress: async (cell) => progress.get(cell) ?? null,
    putProgress: async (p) => void progress.set(p.cellId, p),
  };
}

const vm = (cellId: string, state: VmRow["state"] = "serving"): VmRow => ({ cellId, instanceId: `i-${cellId}`, ip: "10.0.0.1", port: 8080, state, beat: 1, atMs: 1 });

function admin(rows: VmRow[]) {
  const store = memoryStore();
  return { store, admin: new DrainAdmin({ cellId: "0", store, vms: async () => rows, now: () => 42 }) };
}

test("start writes the order, and nothing else", async () => {
  const { store, admin: a } = admin([vm("0"), vm("1")]);
  // As the route calls it: its parsed request also carries `action`, which is not part of an order.
  const status = await a.start({ action: "start", cellId: "0", toCell: "1", big: "skip", leave: true } as never);
  assert.deepEqual(store.orders.get("0"), { cellId: "0", toCell: "1", big: "skip", leave: true, orderedAtMs: 42 });
  assert.equal(status.order?.toCell, "1");
  assert.equal(status.progress, null);
});

test("a cell cannot be drained into itself, nor into a cell nobody serves", async () => {
  const { store, admin: a } = admin([vm("0"), vm("1", "retired")]);
  await assert.rejects(a.start({ cellId: "0", toCell: "0", big: "skip", leave: true }), /into itself/);
  await assert.rejects(a.start({ cellId: "0", toCell: "1", big: "skip", leave: true }), /cell 1 has no serving instance/);
  await assert.rejects(a.start({ cellId: "0", toCell: "7", big: "skip", leave: true }), /cell 7 has no serving instance/);
  assert.equal(store.orders.size, 0);
});

test("A into B is refused while B empties itself — two cells would pass the databases back and forth", async () => {
  const { store, admin: a } = admin([vm("0"), vm("1")]);
  await a.start({ cellId: "1", toCell: "0", big: "skip", leave: true });
  await assert.rejects(a.start({ cellId: "0", toCell: "1", big: "skip", leave: true }), /itself being drained/);
  assert.deepEqual([...store.orders.keys()], ["1"]);
});

test("stop lifts the order; status lists every cell the directory knows", async () => {
  const { store, admin: a } = admin([vm("0"), vm("1")]);
  await a.start({ cellId: "1", toCell: "0", big: "force", leave: false });
  assert.deepEqual((await a.status()).cells.map((c) => [c.cellId, c.order?.big ?? null]), [["0", null], ["1", "force"]]);
  await a.stop("1");
  assert.equal(store.orders.size, 0);
  assert.deepEqual((await a.status("1")).cells.map((c) => c.order), [null]);
});

test("the route: leave defaults to TRUE and big to skip; anything malformed is a 400", () => {
  assert.deepEqual(parseDrainCell({ cell: "0", action: "start", to_cell: "1" }), { action: "start", cellId: "0", toCell: "1", big: "skip", leave: true });
  assert.deepEqual(parseDrainCell({ cell: "0", action: "start", to_cell: "1", big: "force", leave: false }), { action: "start", cellId: "0", toCell: "1", big: "force", leave: false });
  assert.deepEqual(parseDrainCell({ cell: "0", action: "stop" }), { action: "stop", cellId: "0" });
  for (const bad of [null, {}, { cell: "0" }, { cell: "0", action: "start" }, { cell: "a/b", action: "stop" }, { cell: "0", action: "start", to_cell: "1", big: "yes" }]) {
    assert.throws(() => parseDrainCell(bad), /required|must be/);
  }
  assert.deepEqual(parseDrainStatus({}), {});
  assert.deepEqual(parseDrainStatus({ cell: "1" }), { cellId: "1" });
  assert.throws(() => parseDrainStatus({ cell: 3 }), /cell is required/);
});
