// The overlap piece: telling a LIVE predecessor from an absent one
// (t_vm_zero_cut_handover).
//
// Once instances overlap, "no report yet" means two opposite things — nobody is
// there (waiting only extends an outage) or somebody is still writing (starting
// now is the dual writer). The shapes pinned here, most dangerous first:
//   1. an acknowledged predecessor gets the LONG wait — a report arriving after
//      the short one would have expired must still be honoured;
//   2. an ack addressed to ANOTHER instance (a previous roll) is not proof of
//      life for us;
//   3. the launch hook is released BEFORE the wait for the report — the report
//      only comes once the ASG moves on, so the other order waits on itself;
//   4. a second replacement (the first was abandoned) is acknowledged too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgeWarming, awaitAck } from "../service/src/handover/ack.ts";
import { runHandoverGate } from "../service/src/handover/gate.ts";
import { WarmingWatcher } from "../service/src/handover/watcher.ts";
import type { Config } from "../service/src/config.ts";

function fakeDdb() {
  const items = new Map<string, Record<string, unknown>>();
  const onGet: ((key: string) => void)[] = [];
  return {
    items,
    onGet,
    tableName: "registry",
    client: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const put = cmd.constructor.name === "PutItemCommand";
        const src = (put ? cmd.input.Item : cmd.input.Key) as Record<string, { S?: string } | undefined>;
        const key = src.sk?.S ?? "";
        if (put) {
          items.set(key, cmd.input.Item as Record<string, unknown>);
          return {};
        }
        for (const fn of onGet) fn(key);
        return { Item: items.get(key) };
      },
    } as never,
  };
}

const cfg = { handoverTimeoutMs: 1_000, handoverAckMs: 2_000, handoverOverlapTimeoutMs: 60_000 } as Config;
const report = (seq: number) => ({
  org_id: { S: "_handover" }, sk: { S: "current" }, seq: { N: String(seq) },
  fromInstanceId: { S: "i-old" }, atMs: { N: "1" }, dirtyApps: { L: [] }, dirtyUnknown: { BOOL: false },
});
const ackFor = (id: string) => ({ org_id: { S: "_handover" }, sk: { S: "ack" }, fromInstanceId: { S: "i-old" }, forInstanceId: { S: id } });

function gateDeps(ddb: ReturnType<typeof fakeDdb>, clock: { t: number }, events: string[]) {
  return {
    client: ddb.client,
    tableName: ddb.tableName,
    now: () => clock.t,
    sleep: async (ms: number) => void (clock.t += ms),
    instanceId: "i-new",
    baseline: null,
    announcedAtMs: 0,
    completeLaunch: async () => void events.push(`hook-released@${clock.t}`),
    servedKeys: () => [],
    catchUpDeps: { manager: { dbPath: () => "/nope", removeApp: async () => {} }, litestream: { restoreIfMissing: async () => "restored" as const }, serves: () => true },
  };
}

test("an acknowledged predecessor is waited for LONG — its late report is honoured, not timed out", async () => {
  const ddb = fakeDdb();
  ddb.items.set("ack", ackFor("i-new"));
  const clock = { t: 0 };
  const events: string[] = [];
  // The predecessor reports at t=20 s: far past the 1 s short wait.
  ddb.onGet.push((key) => {
    if (key === "current" && clock.t >= 20_000 && !ddb.items.has("current")) ddb.items.set("current", report(1));
  });
  const errors: string[] = [];
  const realError = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    await runHandoverGate(cfg, gateDeps(ddb, clock, events));
  } finally {
    console.error = realError;
  }
  assert.ok(clock.t >= 20_000, "the gate must still be waiting when the report lands");
  assert.equal(errors.filter((e) => e.includes("proceeding-unproven")).length, 0, "a live predecessor's report must not be abandoned at the short timeout");
});

test("nobody answered: the SHORT wait, because every second of it is outage", async () => {
  const ddb = fakeDdb();
  const clock = { t: 0 };
  const realError = console.error;
  console.error = () => {};
  try {
    await runHandoverGate(cfg, gateDeps(ddb, clock, []));
  } finally {
    console.error = realError;
  }
  assert.ok(clock.t < 5_000, `expected ack wait + short wait only, took ${clock.t} ms`);
});

test("an ack left for ANOTHER instance by a previous roll is not proof of life", async () => {
  const ddb = fakeDdb();
  ddb.items.set("ack", ackFor("i-someone-else"));
  const clock = { t: 0 };
  const from = await awaitAck(
    { client: ddb.client, tableName: ddb.tableName, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) },
    { selfInstanceId: "i-new", deadlineMs: 2_000 },
  );
  assert.equal(from, null);
});

test("the launch hook is released AFTER the liveness decision and BEFORE the wait for the report", async () => {
  const ddb = fakeDdb();
  ddb.items.set("ack", ackFor("i-new"));
  const clock = { t: 0 };
  const events: string[] = [];
  ddb.onGet.push((key) => {
    if (key === "ack") events.push("ack-read");
    if (key === "current") {
      events.push("report-read");
      // The predecessor only stops once the hook let the ASG move on.
      if (events.some((e) => e.startsWith("hook-released"))) ddb.items.set("current", report(1));
    }
  });
  await runHandoverGate(cfg, gateDeps(ddb, clock, events));
  const hook = events.findIndex((e) => e.startsWith("hook-released"));
  assert.ok(hook > events.indexOf("ack-read"), "decide whether anyone is there first");
  assert.ok(hook < events.indexOf("report-read"), "waiting for the report before releasing the hook waits on itself");
});

test("the watcher acknowledges AFTER its snapshot, and acknowledges a SECOND replacement too", async () => {
  const ddb = fakeDdb();
  const deps = { client: ddb.client, tableName: ddb.tableName };
  const watcher = new WarmingWatcher({ deps, selfInstanceId: "i-old", readStats: () => new Map() });
  const warming = (id: string) => ({ org_id: { S: "_handover" }, sk: { S: "warming" }, instanceId: { S: id }, atMs: { N: "1" } });

  await watcher.tick();
  assert.equal(ddb.items.has("ack"), false, "nothing to acknowledge yet");

  ddb.items.set("warming", warming("i-new-1"));
  await watcher.tick();
  assert.notEqual(watcher.windowSnapshot, null);
  assert.equal((ddb.items.get("ack") as { forInstanceId: { S: string } }).forInstanceId.S, "i-new-1");

  // The ASG abandoned i-new-1 and launched another. Left un-acked, it would
  // conclude nobody is here and start replicating beside us.
  ddb.items.set("warming", warming("i-new-2"));
  await watcher.tick();
  assert.equal((ddb.items.get("ack") as { forInstanceId: { S: string } }).forInstanceId.S, "i-new-2");

  // And we never acknowledge ourselves.
  assert.equal(await acknowledgeWarming(deps, { selfInstanceId: "i-new-2" }), null);
});
