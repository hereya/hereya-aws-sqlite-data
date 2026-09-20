// Peer watch (t_dbmove_p3_relay_cells): who is declared dead, by whom, on what
// evidence — and what happens when the verdict was wrong.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PeerWatch } from "../../src/peer-watch.ts";
import type { VmIdentity, VmRow, VmState } from "../../src/vms.ts";

const SELF: VmIdentity = { cellId: "0", instanceId: "i-self", ip: "10.0.0.1", port: 8080 };

function world(initial: VmRow[] = []) {
  const state = {
    rows: new Map(initial.map((r) => [r.instanceId, { ...r }])),
    readFails: false,
    deregistered: [] as string[],
    selfRegistrations: 0,
  };
  const directory = {
    async readAll(): Promise<VmRow[]> {
      if (state.readFails) throw new Error("ddb is down");
      return [...state.rows.values()].map((r) => ({ ...r }));
    },
    async put(who: VmIdentity, s: VmState, beat: number): Promise<void> {
      state.rows.set(who.instanceId, { ...who, state: s, beat, atMs: 0 });
    },
    async remove(row: { instanceId: string }): Promise<void> {
      state.rows.delete(row.instanceId);
    },
  };
  const watch = new PeerWatch({
    directory,
    self: SELF,
    deregisterPeer: async (id) => void state.deregistered.push(id),
    registerSelf: async () => void (state.selfRegistrations += 1),
  });
  return { state, watch };
}

const peer = (over: Partial<VmRow> = {}): VmRow => ({
  cellId: "1",
  instanceId: "i-peer",
  ip: "10.0.0.2",
  port: 8080,
  state: "serving",
  beat: 7,
  atMs: 0,
  ...over,
});

test("announce writes our row and clears OUR cell's leftovers — never another cell's", async () => {
  const { state, watch } = world([peer(), peer({ cellId: "0", instanceId: "i-previous", state: "retired" })]);
  await watch.announce();
  assert.deepEqual([...state.rows.keys()].sort(), ["i-peer", "i-self"]);
  assert.equal(state.rows.get("i-self")?.state, "serving");
});

test("every tick moves our counter", async () => {
  const { state, watch } = world();
  await watch.announce();
  await watch.tick();
  await watch.tick();
  assert.equal(state.rows.get("i-self")?.beat, 2);
});

test("a peer whose counter stands still for three of OUR ticks is evicted from discovery", async () => {
  const { state, watch } = world([peer()]);
  await watch.tick(); // first sight: nothing to compare with
  await watch.tick(); // still 1
  await watch.tick(); // still 2
  assert.deepEqual(state.deregistered, []);
  await watch.tick(); // still 3
  assert.deepEqual(state.deregistered, ["i-peer"]);
  assert.equal(state.rows.get("i-peer")?.state, "evicted");
  // Said once: an evicted row is no longer judged.
  await watch.tick();
  assert.deepEqual(state.deregistered, ["i-peer"]);
});

test("a peer that beats, however far its clock is from ours, is never evicted", async () => {
  const { state, watch } = world([peer({ atMs: -1e12 })]);
  for (let i = 0; i < 10; i += 1) {
    state.rows.get("i-peer")!.beat += 1;
    await watch.tick();
  }
  assert.deepEqual(state.deregistered, []);
});

test("a tick WE could not read counts for nothing: our DynamoDB trouble must not evict healthy peers", async () => {
  const { state, watch } = world([peer()]);
  await watch.tick();
  state.readFails = true;
  for (let i = 0; i < 10; i += 1) await watch.tick();
  state.readFails = false;
  await watch.tick(); // still 1
  assert.deepEqual(state.deregistered, []);
});

test("wrongly evicted while alive: the next tick puts us back in discovery and in the directory", async () => {
  const { state, watch } = world();
  await watch.announce();
  state.rows.get("i-self")!.state = "evicted";
  await watch.tick();
  assert.equal(state.selfRegistrations, 1);
  assert.equal(state.rows.get("i-self")?.state, "serving");
});

test("retire says so, and a late tick cannot write `serving` back over it", async () => {
  const { state, watch } = world();
  await watch.announce();
  await watch.retire();
  await watch.tick();
  assert.equal(state.rows.get("i-self")?.state, "retired");
  assert.equal(state.selfRegistrations, 0);
});

test("retired and evicted peers are not judged", async () => {
  const { state, watch } = world([peer({ state: "retired" })]);
  for (let i = 0; i < 6; i += 1) await watch.tick();
  assert.deepEqual(state.deregistered, []);
});
