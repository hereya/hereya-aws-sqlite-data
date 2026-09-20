// Emptying a cell (t_dbmove_p5_drain_ops): an order lifted mid-pass, and the
// databases too big to move inside a write hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { names, ORDER, world } from "../drain-fakes.ts";

test("stop means STOP: an order lifted during a pass starts no further move", async () => {
  const { state, drainer } = world(names(30), { concurrency: 1 });
  state.outcome = (req) => {
    if (req.appId === "app2") state.order = null; // the operator lifts the order while the third app moves
    return "moved";
  };
  const pass = drainer.tick();
  await new Promise((r) => setTimeout(r, 12)); // app0 done, app1 or app2 in flight
  while (state.order !== null) await new Promise((r) => setTimeout(r, 2));
  await drainer.tick(); // what the route's poke does
  await pass;
  assert.ok(state.calls.length <= 4, `${state.calls.length} moves: the queue of 30 was not run to its end`);
  assert.ok(state.held.size >= 26);
});

test("big=skip: a database above the limit is never asked, and the cell does not leave with it on board", async () => {
  const { state, drainer } = world(["small", "huge"], { sizes: { huge: 1_000 } });
  await drainer.tick();
  assert.deepEqual(state.calls, ["small"]);
  assert.deepEqual(state.progress?.skippedBig, ["o/huge"]);
  assert.equal(state.progress?.state, "blocked");
  assert.match(state.progress?.lastError ?? "", /big=skip/);
  assert.equal(state.inCloudMap, true);
});

test("big=force: it is moved like the others, with force", async () => {
  const { state, drainer } = world(["huge"], { sizes: { huge: 1_000 } });
  state.order = { ...ORDER, big: "force" };
  let forced = false;
  state.outcome = (req) => ((forced = req.force === true), "moved");
  await drainer.tick();
  assert.equal(forced, true);
  assert.equal(state.held.size, 0);
});
