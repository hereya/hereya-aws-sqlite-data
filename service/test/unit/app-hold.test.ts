// The per-app hold (t_dbmove_p2_placement): once `hold` has returned, a statement
// of that app is either COUNTED (`inFlight`) or PARKED — never in between. That
// is what a database move will drain on; the eviction sweep covers the same gap
// with a 5-minute grace, which a move cannot afford.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Limiter } from "../../src/limits.ts";
import { CELL_ATTRIBUTE, CloudMapRegistration, isStaleOfCell } from "../../src/cloudmap.ts";

const limiter = () => new Limiter({ maxPerApp: 4, maxTotal: 8 });

test("without a hold, admit is acquire", async () => {
  const l = limiter();
  await l.admit("a");
  assert.equal(l.inFlight("a"), 1);
});

test("a hold parks NEW statements of that app only; the running one stays counted", async () => {
  const l = limiter();
  await l.admit("a");
  const hold = l.hold("a", 5000);
  let admitted = false;
  const parked = l.admit("a").then(() => (admitted = true));
  await l.admit("b");
  await sleep(20);
  assert.equal(admitted, false);
  assert.equal(l.inFlight("a"), 1, "the statement admitted before the hold is what the caller drains");
  assert.equal(l.inFlight("b"), 1, "other apps never notice");
  l.release("a");
  assert.equal(l.inFlight("a"), 0, "drained: nothing of this app is running, nothing can start");
  assert.equal(hold.release(), true);
  await parked;
  assert.equal(l.inFlight("a"), 1);
});

test("a hold taken while statements are parked on the previous one keeps them parked", async () => {
  const l = limiter();
  const first = l.hold("a", 5000);
  let admitted = false;
  void l.admit("a").then(() => (admitted = true));
  await sleep(5);
  first.release();
  const second = l.hold("a", 5000); // same tick as the release: the waiter has not resumed yet
  await sleep(20);
  assert.equal(admitted, false);
  second.release();
  await sleep(5);
  assert.equal(admitted, true);
});

test("an expired hold lets statements through and SAYS so at release", async () => {
  const l = limiter();
  const hold = l.hold("a", 15);
  await l.admit("a");
  assert.equal(l.isHeld("a"), false);
  assert.equal(hold.release(), false, "what ran under it was not exclusive — the caller must abort");
});

test("one hold per app: a second caller is refused, not queued", () => {
  const l = limiter();
  l.hold("a", 5000);
  assert.throws(() => l.hold("a", 5000), /already held/);
});

// --- Cloud Map: clear MY cell's leftovers, not everyone's -------------------

test("a registration without the cell attribute belongs to the origin cell", () => {
  assert.equal(isStaleOfCell(undefined, "0"), true);
  assert.equal(isStaleOfCell({ AWS_INSTANCE_IPV4: "10.0.0.1" }, "1"), false);
  assert.equal(isStaleOfCell({ [CELL_ATTRIBUTE]: "1" }, "1"), true);
  assert.equal(isStaleOfCell({ [CELL_ATTRIBUTE]: "1" }, "0"), false);
});

test("boot deregisters this cell's stale instances and leaves the other cell in discovery", async () => {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name !== "ListInstancesCommand") return {};
      return {
        Instances: [
          { Id: "i-legacy", Attributes: { AWS_INSTANCE_IPV4: "10.0.0.1" } },
          { Id: "i-mine-dead", Attributes: { [CELL_ATTRIBUTE]: "0" } },
          { Id: "i-other-cell", Attributes: { [CELL_ATTRIBUTE]: "1" } },
        ],
      };
    },
  };
  const reg = new CloudMapRegistration({
    serviceId: "srv",
    region: "eu-west-1",
    port: 8080,
    cellId: "0",
    client: client as never,
    identity: async () => ["i-new", "10.0.0.9"],
  });
  await reg.register();
  const gone = sent.filter((s) => s.name === "DeregisterInstanceCommand").map((s) => s.input.InstanceId);
  assert.deepEqual(gone, ["i-legacy", "i-mine-dead"]);
  const registered = sent.find((s) => s.name === "RegisterInstanceCommand")!.input;
  assert.equal(registered.InstanceId, "i-new");
  assert.equal((registered.Attributes as Record<string, string>)[CELL_ATTRIBUTE], "0");
});
