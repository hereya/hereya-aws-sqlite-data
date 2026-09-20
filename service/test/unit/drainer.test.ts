// Emptying a cell (t_dbmove_p5_drain_ops): what the drainer asks of the mover,
// when it stops asking, and when the cell leaves — and re-enters — Cloud Map.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BREAKER_FAILURES, Drainer } from "../../src/drain/drainer.ts";
import type { DrainOrder, DrainProgress } from "../../src/drain/store.ts";
import { ServiceError } from "../../src/errors.ts";
import type { MoveRequest, MoveResult } from "../../src/move/mover.ts";

const ORDER: DrainOrder = { cellId: "0", toCell: "1", big: "skip", leave: true, orderedAtMs: 1 };

function world(apps: string[], opts: { sizes?: Record<string, number>; concurrency?: number } = {}) {
  const state = {
    order: { ...ORDER } as DrainOrder | null,
    orderReadFails: false,
    held: new Set(apps),
    targetUp: true,
    inCloudMap: true,
    calls: [] as string[],
    running: 0,
    maxRunning: 0,
    progress: null as DrainProgress | null,
    outcome: (_req: MoveRequest): "moved" | "resumed" | Error => "moved",
  };
  const drainer = new Drainer({
    cellId: "0",
    instanceId: () => "i-self",
    store: {
      readOrder: async () => {
        if (state.orderReadFails) throw new Error("ddb is down");
        return state.order;
      },
      putOrder: async () => {},
      deleteOrder: async () => {},
      readProgress: async () => state.progress,
      putProgress: async (p) => void (state.progress = p),
    },
    listHeld: async () => [...state.held].map((appId) => ({ orgId: "o", appId })),
    sizeOf: (_o, appId) => opts.sizes?.[appId] ?? 1,
    isMoving: () => false,
    moveOut: async (req): Promise<MoveResult> => {
      state.calls.push(req.appId);
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      await new Promise((r) => setTimeout(r, 5));
      state.running -= 1;
      const outcome = state.outcome(req);
      if (outcome instanceof Error) throw outcome;
      if (outcome === "moved") state.held.delete(req.appId);
      return { status: outcome, fromCell: "0", toCell: req.toCell, version: 1, pauseMs: 5, ...(outcome === "resumed" ? { reason: "the target did not claim the app" } : {}) };
    },
    targetReachable: async () => state.targetUp,
    presence: () => ({
      get inCloudMap() {
        return state.inCloudMap;
      },
      leave: async () => void (state.inCloudMap = false),
      enter: async () => void (state.inCloudMap = true),
    }),
    isShuttingDown: () => false,
    gatewayQuietMs: () => 1234,
    concurrency: opts.concurrency ?? 8,
    maxBytes: 100,
  });
  return { state, drainer };
}

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `app${i}`);

test("no order: nothing is asked of the mover, and the cell stays in Cloud Map", async () => {
  const { state, drainer } = world(names(3));
  state.order = null;
  await drainer.tick();
  assert.deepEqual(state.calls, []);
  assert.equal(state.inCloudMap, true);
  assert.equal(state.progress, null);
});

test("a pass moves every app, several at a time and never more than the width", async () => {
  const { state, drainer } = world(names(20), { concurrency: 4 });
  await drainer.tick();
  assert.equal(state.held.size, 0);
  assert.equal(state.calls.length, 20);
  assert.equal(state.maxRunning, 4, "a serial loop would be 1, an unbounded one 20");
  assert.equal(state.progress?.state, "empty");
  assert.equal(state.progress?.moved, 20);
});

test("smallest first: the cheap moves do not queue behind a long one", async () => {
  const { state, drainer } = world(["big", "small", "mid"], { sizes: { big: 90, small: 1, mid: 50 }, concurrency: 1 });
  await drainer.tick();
  assert.deepEqual(state.calls, ["small", "mid", "big"]);
});

test("an emptied cell leaves Cloud Map — and only when the order says so", async () => {
  const leaving = world(names(2));
  await leaving.drainer.tick();
  assert.equal(leaving.state.inCloudMap, false);
  assert.equal(leaving.state.progress?.inCloudMap, false);
  assert.equal(leaving.state.progress?.gatewayQuietMs, 1234, "out of Cloud Map is not out of the gateway: the operator reads this before replacing the instance");

  const staying = world(names(2));
  staying.state.order = { ...ORDER, leave: false };
  await staying.drainer.tick();
  assert.equal(staying.state.held.size, 0);
  assert.equal(staying.state.inCloudMap, true);
});

test("the order is lifted: the cell walks back into Cloud Map", async () => {
  const { state, drainer } = world(names(1));
  await drainer.tick();
  assert.equal(state.inCloudMap, false);
  state.order = null;
  await drainer.tick();
  assert.equal(state.inCloudMap, true);
});

test("an unreadable order is no judgement: no move, no leave, no re-entry, no throw", async () => {
  const { state, drainer } = world(names(1));
  await drainer.tick();
  assert.equal(state.inCloudMap, false);
  state.orderReadFails = true;
  await drainer.tick();
  assert.equal(state.inCloudMap, false, "blind must not read as 'the order was lifted'");
});

test("an app born on an emptied cell is moved at the next tick, and the cell stays out", async () => {
  const { state, drainer } = world(names(1));
  await drainer.tick();
  state.held.add("newborn");
  await drainer.tick();
  assert.equal(state.held.size, 0);
  assert.equal(state.inCloudMap, false);
  assert.equal(state.progress?.moved, 2);
});

test("a target with no serving instance: NOT ONE app is paused", async () => {
  const { state, drainer } = world(names(5));
  state.targetUp = false;
  await drainer.tick();
  assert.deepEqual(state.calls, []);
  assert.equal(state.progress?.state, "blocked");
  assert.match(state.progress?.lastError ?? "", /no serving instance/);
  assert.equal(state.inCloudMap, true);
});

test("the breaker: a target that claims nothing costs a few pauses, not one per app", async () => {
  const { state, drainer } = world(names(40), { concurrency: 1 });
  state.outcome = () => "resumed";
  await drainer.tick();
  assert.equal(state.calls.length, BREAKER_FAILURES);
  assert.equal(state.progress?.state, "blocked");
  assert.equal(state.held.size, 40);
});

test("after a blocked pass the next ticks are skipped — a timer only decides to TRY again", async () => {
  const { state, drainer } = world(names(10), { concurrency: 1 });
  state.outcome = () => "resumed";
  await drainer.tick();
  const after = state.calls.length;
  await drainer.tick();
  await drainer.tick();
  assert.equal(state.calls.length, after, "two ticks skipped after the first blocked pass");
  state.outcome = () => "moved";
  await drainer.tick();
  assert.equal(state.held.size, 0);
});

test("a NEW order resets the back-off of the previous one", async () => {
  const { state, drainer } = world(names(3), { concurrency: 1 });
  state.outcome = () => "resumed";
  await drainer.tick();
  state.outcome = () => "moved";
  state.order = { ...ORDER, orderedAtMs: 2 };
  await drainer.tick();
  assert.equal(state.held.size, 0);
});

test("a move refused before anything was written does not trip the breaker", async () => {
  const { state, drainer } = world(names(10), { concurrency: 1 });
  state.outcome = (req) => (["app0", "app1", "app2", "app3"].includes(req.appId) ? new ServiceError("MOVE_ABORTED", "the app has an open transaction; nothing was changed") : "moved");
  await drainer.tick();
  assert.equal(state.calls.length, 10, "the four refusals paused nobody, so the pass went on");
  assert.deepEqual([...state.held].sort(), ["app0", "app1", "app2", "app3"]);
  assert.equal(state.progress?.failed, 4);
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
