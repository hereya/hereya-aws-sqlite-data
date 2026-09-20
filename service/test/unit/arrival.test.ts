// The side a database ARRIVES on (t_dbmove_p4_move). The order is the safety
// property: clear BEFORE the claim, claim BEFORE the restore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiter } from "../../src/limits.ts";
import { Arrival } from "../../src/move/arrival.ts";
import { sweepMoves } from "../../src/move/sweep.ts";
import { MemoryMoveRecord } from "../move-fakes.ts";

const ORG = "org-a";
const APP = "app-1";

async function stopped(record: MemoryMoveRecord, to = "1"): Promise<number> {
  const version = (await record.begin(ORG, APP, "0", to))!;
  await record.reportStopped(ORG, APP, version);
  return version;
}

function setup(over: { clear?: () => Promise<void>; ensure?: () => Promise<void> } = {}) {
  const record = new MemoryMoveRecord();
  const steps: string[] = [];
  const arrival = new Arrival({
    cellId: "1",
    record,
    limiter: new Limiter({ maxPerApp: 4, maxTotal: 8 }),
    clearForArrival: over.clear ?? (async () => void steps.push("clear")),
    ensureServed: over.ensure ?? (async () => void steps.push(`restore(holder=${record.holder(ORG, APP, "0")})`)),
    reloadPlacement: () => void steps.push("reload"),
  });
  return { arrival, record, steps };
}

test("clear, THEN claim, THEN restore — and the restore runs with the row already ours", async () => {
  const { arrival, record, steps } = setup();
  const version = await stopped(record);
  await arrival.moveIn({ orgId: ORG, appId: APP, version });
  assert.deepEqual(steps, ["clear", "reload", "restore(holder=1)"]);
  assert.deepEqual(record.log, ["begin", "a_stopped", "claim", "finalize"]);
  assert.deepEqual(await record.read(ORG, APP), { key: `${ORG}/${APP}`, vmId: "1", version: version + 1, phase: null, targetVm: null });
});

test("no stopped move towards THIS cell: nothing is cleared, nothing is claimed", async () => {
  for (const stage of ["no-row", "still-moving", "other-target", "stale-version"] as const) {
    const { arrival, record, steps } = setup();
    let version = 1;
    if (stage === "still-moving") version = (await record.begin(ORG, APP, "0", "1"))!;
    if (stage === "other-target") version = await stopped(record, "2");
    if (stage === "stale-version") version = (await stopped(record)) + 5;
    await assert.rejects(arrival.moveIn({ orgId: ORG, appId: APP, version }), /no stopped move/, stage);
    assert.deepEqual(steps, [], stage);
    assert.ok(!record.log.includes("claim"), stage);
  }
});

test("the source cancelled first: the claim fails and NOTHING is restored here", async () => {
  let version = 0;
  const ctx = setup({
    // The source gives up while we clear.
    clear: async () => void (await ctx.record.cancel(ORG, APP, version)),
  });
  version = await stopped(ctx.record);
  await assert.rejects(ctx.arrival.moveIn({ orgId: ORG, appId: APP, version }), /cancelled before/);
  assert.deepEqual(ctx.steps, []);
});

test("a cell that already serves the app refuses BEFORE the claim — its file is live data", async () => {
  const { arrival, record } = setup({
    clear: async () => {
      throw new Error("the target cell already serves this app");
    },
  });
  const version = await stopped(record);
  await assert.rejects(arrival.moveIn({ orgId: ORG, appId: APP, version }), /already serves/);
  assert.equal((await record.read(ORG, APP))!.phase, "a_stopped", "the source can still cancel");
});

test("a restore that fails AFTER the claim undoes nothing: the app is ours, the next statement retries", async () => {
  const { arrival, record } = setup({
    ensure: async () => {
      throw new Error("s3 unreachable");
    },
  });
  const version = await stopped(record);
  await assert.rejects(arrival.moveIn({ orgId: ORG, appId: APP, version }), /s3 unreachable/);
  assert.equal(record.holder(ORG, APP, "0"), "1");
  assert.equal(await record.cancel(ORG, APP, version), false, "after b_started there is no way back");
});

test("sweep: an orphaned move of ours is cancelled, one claimed by us is finalized, a live one is left alone", async () => {
  const record = new MemoryMoveRecord();
  const v1 = (await record.begin("o", "leaving", "0", "1"))!;
  await record.reportStopped("o", "leaving", v1);
  const v2 = (await record.begin("o", "arriving", "1", "0"))!;
  await record.reportStopped("o", "arriving", v2);
  await record.claim("o", "arriving", v2, "0");
  await record.begin("o", "live", "0", "1");
  await record.begin("o", "theirs", "1", "2");
  const out = await sweepMoves({ cellId: "0", record, isActive: (k) => k === "o/live", dbDir: "/nonexistent", keepMs: 1 });
  assert.deepEqual({ cancelled: out.cancelled, finalized: out.finalized }, { cancelled: 1, finalized: 1 });
  assert.equal((await record.read("o", "leaving"))!.phase, null);
  assert.equal((await record.read("o", "arriving"))!.vmId, "0");
  assert.equal((await record.read("o", "live"))!.phase, "moving");
  assert.equal((await record.read("o", "theirs"))!.phase, "moving");
});

test("sweep: a move the target CLAIMED is not ours to cancel — the write fails, the app stays theirs", async () => {
  const record = new MemoryMoveRecord();
  const v = (await record.begin("o", "a", "0", "1"))!;
  await record.reportStopped("o", "a", v);
  await record.claim("o", "a", v, "1");
  const out = await sweepMoves({ cellId: "0", record, isActive: () => false, dbDir: "/nonexistent", keepMs: 1 });
  assert.equal(out.cancelled, 0);
  assert.equal(record.holder("o", "a", "0"), "1");
});
