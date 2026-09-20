// The side a database LEAVES (t_dbmove_p4_move). Two rules are pinned here:
// the outcome is READ from the row whatever the target answered, and until it
// is known nothing runs on this cell — a parked statement is refused, not run.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import { Limiter } from "../../src/limits.ts";
import { Mover, type MoveOutDeps } from "../../src/move/mover.ts";
import { MemoryMoveRecord } from "../move-fakes.ts";

const ORG = "org-a";
const APP = "app-1";
const KEY = `${ORG}/${APP}`;

function setup(over: Partial<MoveOutDeps> = {}) {
  const record = new MemoryMoveRecord();
  const limiter = new Limiter({ maxPerApp: 4, maxTotal: 8 });
  const calls: string[] = [];
  const state = { openTx: false, pending: false };
  const deps: MoveOutDeps = {
    cellId: "0",
    record,
    limiter,
    hasOpenTx: () => state.openTx,
    dbPath: () => "/nonexistent/app.db",
    served: {
      isPending: () => state.pending,
      markDeparting: () => void calls.push("mark"),
      detach: async () => void calls.push("detach"),
      reattach: async () => void calls.push("reattach"),
      forget: () => void calls.push("forget"),
    },
    // A target that does its job: claims, then answers.
    askTarget: async (to) => {
      calls.push("ask");
      const row = await record.read(ORG, APP);
      await record.claim(ORG, APP, row!.version, to);
      return 200;
    },
    reloadPlacement: () => void calls.push("reload"),
    drainMs: 80,
    maxBytes: 1024,
    ...over,
  };
  return { mover: new Mover(deps), record, limiter, calls, state };
}

const code = (err: unknown): string => (err as ServiceError).code;

test("the target claims: moved — and a statement parked during the move is sent AWAY, never run here", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { mover, limiter, calls, record } = setup({
    askTarget: async (to) => {
      await gate;
      await record.claim(ORG, APP, 1, to);
      return 200;
    },
  });
  const moving = mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" });
  await sleep(30);
  const parked = limiter.admit(KEY).then(() => "ran", code);
  await sleep(10);
  release();
  const result = await moving;
  assert.equal(result.status, "moved");
  assert.equal(await parked, "MISPLACED");
  assert.equal(limiter.inFlight(KEY), 0);
  assert.deepEqual(calls, ["mark", "detach", "reload", "forget"]);
  assert.deepEqual(record.log, ["begin", "a_stopped", "claim"]);
});

test("the answer is LOST after the target claimed: still moved — the row decides, not the answer", async () => {
  const { mover, record, calls } = setup({
    askTarget: async (to) => {
      await record.claim(ORG, APP, 1, to);
      throw new Error("socket hang up");
    },
  });
  assert.equal((await mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" })).status, "moved");
  assert.ok(!calls.includes("reattach"), "resuming here would be the dual writer");
});

test("the target never claims: cancelled, replicated again BEFORE the parked statement runs", async () => {
  const order: string[] = [];
  const { mover, limiter, record } = setup({
    askTarget: async () => {
      throw new Error("connect timed out");
    },
    served: {
      isPending: () => false,
      markDeparting: () => {},
      detach: async () => {},
      reattach: async () => {
        await sleep(20);
        order.push("reattached");
      },
      forget: () => assert.fail("must not forget a resumed app"),
    },
  });
  const moving = mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" });
  await sleep(10);
  const parked = limiter.admit(KEY).then(() => order.push("statement"));
  const result = await moving;
  await parked;
  assert.equal(result.status, "resumed");
  assert.match(result.reason!, /connect timed out|did not claim/);
  assert.deepEqual(order, ["reattached", "statement"]);
  assert.deepEqual(record.log, ["begin", "a_stopped", "cancel"]);
  // A late claim from that target must now FAIL: cancel won.
  assert.equal(await record.claim(ORG, APP, 1, "1"), false);
});

test("an open transaction: nothing is written, nothing is held", async () => {
  const { mover, record, limiter, state } = setup();
  state.openTx = true;
  await assert.rejects(mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" }), (e) => code(e) === "MOVE_ABORTED");
  assert.deepEqual(record.log, []);
  assert.equal(limiter.isHeld(KEY), false);
  await limiter.admit(KEY);
});

test("a statement that will not drain: the move gives up and the app is open again", async () => {
  const { mover, limiter, record, calls } = setup();
  await limiter.admit(KEY); // never released
  const result = await mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" });
  assert.equal(result.status, "resumed");
  assert.match(result.reason!, /did not drain/);
  assert.ok(!calls.includes("detach"), "litestream was never touched");
  assert.deepEqual(record.log, ["begin", "cancel"]);
  await limiter.admit(KEY);
});

test("a litestream stop that was not observed aborts — `a_stopped` is never written on a guess", async () => {
  const { mover, record, calls } = setup({
    served: {
      isPending: () => false,
      markDeparting: () => {},
      detach: async () => {
        throw new Error("litestream stop failed: timeout");
      },
      reattach: async () => void calls.push("reattach"),
      forget: () => {},
    },
  });
  const result = await mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" });
  assert.equal(result.status, "resumed");
  assert.ok(!record.log.includes("a_stopped"));
  assert.deepEqual(calls, ["reattach"]);
});

test("the hold EXPIRES while the outcome is unknown: statements are refused (503), not run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { mover, limiter, record } = setup({
    holdMs: 30,
    askTarget: async (to) => {
      await gate;
      await record.claim(ORG, APP, 1, to);
      return 200;
    },
  });
  const moving = mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" });
  await sleep(10);
  const parked = limiter.admit(KEY).then(() => "ran", code);
  assert.equal(await parked, "UNAVAILABLE", "woken by the expiry, with litestream already detached");
  assert.equal(await limiter.admit(KEY).then(() => "ran", code), "UNAVAILABLE");
  release();
  assert.equal((await moving).status, "moved");
  assert.equal(await limiter.admit(KEY).then(() => "ran", code), "MISPLACED");
});

test("the row cannot be read: the app stays closed until it can — no timer decides", async () => {
  const ctx = setup({
    askTarget: async () => {
      ctx.record.failReads = 2;
      return 500;
    },
  });
  const { mover, limiter } = ctx;
  const moving = mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" });
  let settled = false;
  void moving.then(() => (settled = true));
  await sleep(150);
  assert.equal(settled, false);
  const probe = limiter.whileHeld(KEY).then(() => "open", code);
  assert.equal(await Promise.race([probe, sleep(50).then(() => "parked")]), "parked");
  assert.equal((await moving).status, "resumed");
});

test("an oversized database is refused unless forced; a second move of the same app is refused", async () => {
  const { mover } = setup({ maxBytes: -1 });
  await assert.rejects(mover.moveOut({ orgId: ORG, appId: APP, toCell: "1" }), /force/);
  assert.equal((await mover.moveOut({ orgId: ORG, appId: APP, toCell: "1", force: true })).status, "moved");
  await assert.rejects(setup().mover.moveOut({ orgId: ORG, appId: APP, toCell: "0" }), /already on this cell/);
});
