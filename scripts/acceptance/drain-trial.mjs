// Emptying a REAL cell into another (t_dbmove_p5_drain_ops) — throwaway stack,
// vmCount=2, handover on, seeded at prod scale first:
//
//   node scripts/acceptance/handover-scale.mjs seed <stack> 100
//   node scripts/acceptance/drain-trial.mjs <stack>
//
// What no test can see: 100 moves 8 at a time on a t4g.micro, under load; the
// role really may write the order and progress rows; the emptied cell really
// leaves Cloud Map, and — the point of the whole plan — REPLACING ITS INSTANCE IS
// THEN SEEN BY NOBODY; its replacement stays out; lifting the order brings it
// back; and `last_sync_at` behaves on S3 as it did on a file replica (an idle
// database has no lag), or the new alarm would fire on every quiet night.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";
import { stackOutputs } from "./stack-info.mjs";

const [, , stackName] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
if (!stackName) throw new Error("usage: drain-trial.mjs <stack>");
if (/prod|p-263b1e67|p-c3fb06fc/i.test(stackName)) throw new Error("refusing to run against a production stack");

const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const table = outputs.registryTableName;
const ddb = new DynamoDBClient({ region });
const ORG = "scale-org"; // seeded by handover-scale.mjs: scale-000 … scale-099, table t(k, v), on cell 0
const app = (n) => `scale-${String(n).padStart(3, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ASYNC on purpose (move-trial.mjs learnt it): a blocking call freezes the writers and reads as an outage.
const run = promisify(execFile);
const aws = async (args) => JSON.parse((await run("aws", [...args, "--region", region, "--output", "json"], { maxBuffer: 64 * 1024 * 1024 })).stdout || "null");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const timed = (p, ms = 12_000) => Promise.race([p, sleep(ms).then(() => ({ status: 0, body: null }))]).catch(() => ({ status: 0, body: null }));
const call = (path, body, ms) => timed(signedCall(api, path, body, region), ms);
const query = (appId, sql) => call("/query", { org_id: ORG, app_id: appId, sql });
const statusOf = async (cell) => (await call("/admin/drain-status", { cell })).body?.cells?.[0] ?? null;

async function placements() {
  const rows = new Map();
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "org_id = :p", ExpressionAttributeValues: { ":p": { S: "_placement" } }, ConsistentRead: true, ExclusiveStartKey }));
    for (const item of res.Items ?? []) rows.set(item.sk.S, { vmId: item.vmId?.S, phase: item.phase?.S ?? null });
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}
/** How many of the seeded apps each cell holds, and how many rows still carry a phase. */
async function census(appIds) {
  const rows = await placements();
  const held = { 0: 0, 1: 0 };
  for (const id of appIds) held[rows.get(`${ORG}/${id}`)?.vmId ?? "0"] += 1;
  return { held, midMove: [...rows.values()].filter((r) => r.phase !== null).length };
}
async function cloudMapCells() {
  const services = (await aws(["servicediscovery", "list-services"])).Services;
  const out = [];
  for (const s of services) {
    const tags = (await aws(["servicediscovery", "list-tags-for-resource", "--resource-arn", s.Arn])).Tags ?? [];
    if (!tags.some((t) => t.Key === "aws:cloudformation:stack-name" && t.Value === stackName)) continue;
    for (const i of (await aws(["servicediscovery", "list-instances", "--service-id", s.Id])).Instances) out.push(i.Attributes?.DILAYA_CELL ?? "0");
  }
  return out.sort();
}
async function asgOfCell(cell) {
  const groups = (await aws(["autoscaling", "describe-auto-scaling-groups"])).AutoScalingGroups.filter((g) => g.Tags?.some((t) => t.Key === "aws:cloudformation:stack-name" && t.Value === stackName));
  return groups.find((g) => (cell === "0" ? !/AsgCell/.test(g.AutoScalingGroupName) : g.AutoScalingGroupName.includes(`AsgCell${cell}`)));
}

/** Write one row every ~100 ms until stopped; remembers what was ACKNOWLEDGED, every error, and the longest silence. */
function writer(appId, tag) {
  const state = { appId, acked: [], errors: {}, maxGapMs: 0, stop: false };
  let last = Date.now();
  state.done = (async () => {
    for (let i = 0; !state.stop; i++) {
      const res = await query(appId, `INSERT OR REPLACE INTO t VALUES ('${tag}-${i}', 'x')`);
      if (res.status === 200) {
        state.acked.push(`${tag}-${i}`);
        state.maxGapMs = Math.max(state.maxGapMs, Date.now() - last);
        last = Date.now();
      } else {
        const who = res.body?.error?.code ? `${res.status}:${res.body.error.code}` : `${res.status}:gateway`;
        state.errors[who] = (state.errors[who] ?? 0) + 1;
      }
      await sleep(100);
    }
  })();
  return state;
}
async function missing(appId, keys) {
  let res = await query(appId, "SELECT k FROM t");
  for (let i = 0; res.status !== 200 && i < 10; i++) { await sleep(1000); res = await query(appId, "SELECT k FROM t"); }
  if (res.status !== 200) return keys;
  const have = new Set(res.body.records.map((r) => r[0].stringValue));
  return keys.filter((k) => !have.has(k));
}
const summary = (ws) => JSON.stringify(ws.map((w) => ({ app: w.appId, acked: w.acked.length, maxGapMs: w.maxGapMs, errors: w.errors })));
async function waitForState(cell, want, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await statusOf(cell);
    if (last?.progress && want(last.progress)) return { progress: last.progress, ms: Date.now() - started };
    await sleep(2000);
  }
  return { progress: last?.progress ?? null, ms: Date.now() - started, timedOut: true };
}

const APPS = Array.from({ length: 100 }, (_, i) => app(i));
const before = await census(APPS);
check("start: the 100 seeded apps are on cell 0, nothing mid-move", before.held[0] === 100 && before.midMove === 0, JSON.stringify(before));
check("start: both cells are gateway targets", JSON.stringify(await cloudMapCells()) === '["0","1"]', JSON.stringify(await cloudMapCells()));

// 1. drain 0 → 1 under load: five apps written throughout, all of them among the moved
const writers = [3, 27, 51, 76, 98].map((n) => writer(app(n), "d1"));
await sleep(3000);
const order = await call("/admin/drain-cell", { cell: "0", action: "start", to_cell: "1" }, 35_000);
check("the order is accepted (any cell answers; the role may write `_vms`)", order.status === 200 && order.body?.order?.toCell === "1", `${order.status} ${JSON.stringify(order.body)}`);
const refused = await call("/admin/drain-cell", { cell: "1", action: "start", to_cell: "0" }, 35_000);
check("draining the TARGET back into the source is refused while the first order stands", refused.status === 400, `${refused.status} ${JSON.stringify(refused.body)}`);
const drained = await waitForState("0", (p) => p.state === "empty", 300_000);
check("cell 0 reports EMPTY", !drained.timedOut, `${drained.ms} ms, ${JSON.stringify(drained.progress)}`);
await sleep(3000);
for (const w of writers) w.stop = true;
await Promise.all(writers.map((w) => w.done));
const after1 = await census(APPS);
check("every app is on cell 1, no row left mid-move", after1.held[1] === 100 && after1.midMove === 0, JSON.stringify(after1));
const lost1 = (await Promise.all(writers.map((w) => missing(w.appId, w.acked)))).flat();
check("written THROUGH the drain: nothing acknowledged is lost, nothing refused by the service", lost1.length === 0 && writers.every((w) => Object.keys(w.errors).every((k) => k.endsWith(":gateway"))), `lost ${lost1.length}; ${summary(writers)}`);
// 8 at a time, not 100: opening 100 workers at once evicts some mid-request ("app is shutting
// down", 503) on ANY stack, drained or not — the first run read that as a drain failure.
const reads = [];
for (let i = 0; i < APPS.length; i += 8) reads.push(...(await Promise.all(APPS.slice(i, i + 8).map((id) => query(id, "SELECT count(*) FROM t")))));
check("all 100 apps answer from cell 1", reads.every((r) => r.status === 200), JSON.stringify(reads.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.body?.error?.code ?? "gateway"}`)));

// 2. the emptied cell leaves Cloud Map
let targets = [];
for (let i = 0; i < 20 && JSON.stringify(targets) !== '["1"]'; i++) { await sleep(3000); targets = await cloudMapCells(); }
check("cell 0 LEFT Cloud Map once empty", JSON.stringify(targets) === '["1"]', JSON.stringify(targets));

// 3. an app born while the origin is drained (no row = the origin) is moved by itself
await ddb.send(new PutItemCommand({ TableName: table, Item: { org_id: { S: ORG }, sk: { S: "app#newborn" }, appId: { S: "newborn" }, name: { S: "newborn" }, status: { S: "active" }, created_at: { S: new Date().toISOString() } } }));
await call("/admin/sync", {});
const born = await query("newborn", "CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)");
const put = await query("newborn", "INSERT OR REPLACE INTO t VALUES ('first', 'x')"); // OR REPLACE: a second run on the same stack
check("the newborn is created and written (on the drained origin, through the relay)", born.status === 200 && put.status === 200, `${born.status} ${put.status} ${JSON.stringify(put.body)}`);
let bornOn = "0";
for (let i = 0; i < 45 && bornOn !== "1"; i++) { await sleep(2000); bornOn = (await placements()).get(`${ORG}/newborn`)?.vmId ?? "0"; }
check("…and is on cell 1 within a few polls, its row intact", bornOn === "1" && (await missing("newborn", ["first"])).length === 0, `held by ${bornOn}`);

// 4. THE POINT: replacing the instance of the emptied cell is seen by nobody — ONCE THE GATEWAY
// HAS LET GO OF IT. Out of Cloud Map is not out of the gateway (first run: requests still arrived
// ~25 s later, and an instance replaced then showed its 503s to clients). The cell says so itself.
const probes = [5, 40, 77].map((n) => writer(app(n), "roll"));
const quiet = await waitForState("0", (p) => p.state === "empty" && !p.inCloudMap && (p.gatewayQuietMs ?? 0) >= 90_000, 600_000);
check("the emptied cell reports the gateway has let go of it (gatewayQuietMs ≥ 90 s)", !quiet.timedOut, `after ${quiet.ms} ms; ${JSON.stringify(quiet.progress)}`);
const group = await asgOfCell("0");
const oldInstance = group.Instances.find((i) => i.LifecycleState === "InService")?.InstanceId;
await aws(["autoscaling", "terminate-instance-in-auto-scaling-group", "--instance-id", oldInstance, "--no-should-decrement-desired-capacity"]);
let replacement = null;
for (let i = 0; i < 100 && !replacement; i++) {
  await sleep(5000);
  const st = await statusOf("0");
  replacement = st?.instances.find((x) => x.instanceId !== oldInstance && x.state === "serving")?.instanceId ?? null;
}
check("cell 0 is back on a NEW instance, announced in `_vms`", Boolean(replacement), `${oldInstance} → ${replacement}`);
await sleep(45_000); // one poll of the newcomer, and whatever a late registration would cost
for (const p of probes) p.stop = true;
await Promise.all(probes.map((p) => p.done));
// A 5xx WITHOUT error.code is the gateway alone (integrationLatency 0 — background of this stack,
// ~1 per 600 requests under concurrent load, before any drain); one WITH a code was said by a VM.
const vmErrors = probes.flatMap((p) => Object.keys(p.errors).filter((k) => !k.endsWith(":gateway")));
const gatewayOnly = probes.reduce((n, p) => n + (p.errors["503:gateway"] ?? 0), 0);
const sent = probes.reduce((n, p) => n + p.acked.length, 0);
check("replacing the emptied cell's instance: no VM ever refused a client, no silence, gateway-only 503s at the background rate", vmErrors.length === 0 && probes.every((p) => p.maxGapMs < 3000) && gatewayOnly <= Math.ceil(sent / 100), `gateway-only ${gatewayOnly}/${sent}; ${summary(probes)}`);
check("the replacement STAYED OUT of Cloud Map", JSON.stringify(await cloudMapCells()) === '["1"]', JSON.stringify(await cloudMapCells()));

// 5. lift the order: the cell walks back in; then drain the other way and back out
const lifted = await call("/admin/drain-cell", { cell: "0", action: "stop" }, 35_000);
targets = [];
for (let i = 0; i < 30 && JSON.stringify(targets) !== '["0","1"]'; i++) { await sleep(3000); targets = await cloudMapCells(); }
check("order lifted: cell 0 is a gateway target again", lifted.status === 200 && JSON.stringify(targets) === '["0","1"]', JSON.stringify(targets));

const writersBack = [3, 27, 51, 76, 98].map((n) => writer(app(n), "d2"));
await sleep(2000);
await call("/admin/drain-cell", { cell: "1", action: "start", to_cell: "0", leave: false }, 35_000);
const drainedBack = await waitForState("1", (p) => p.state === "empty", 300_000);
await sleep(3000);
for (const w of writersBack) w.stop = true;
await Promise.all(writersBack.map((w) => w.done));
const after2 = await census([...APPS, "newborn"]);
const lost2 = (await Promise.all(writersBack.map((w) => missing(w.appId, w.acked)))).flat();
check("drained BACK 1 → 0 (each app returns to a cell that held an older copy of it): all 101 on cell 0, nothing lost", !drainedBack.timedOut && after2.held[0] === 101 && after2.midMove === 0 && lost2.length === 0, `${drainedBack.ms} ms; ${JSON.stringify(after2)}; lost ${lost2.length}; ${summary(writersBack)}`);
check("leave:false — cell 1 is still a gateway target", JSON.stringify(await cloudMapCells()) === '["0","1"]', JSON.stringify(await cloudMapCells()));
await call("/admin/drain-cell", { cell: "1", action: "stop" }, 35_000);

// 6. the lag metric on S3: published by both cells, and an idle database has none
await sleep(90_000);
const cw = new CloudWatchClient({ region });
for (const [cell, Dimensions] of [["0", [{ Name: "stack", Value: stackName }]], ["1", [{ Name: "stack", Value: stackName }, { Name: "cell", Value: "1" }]]]) {
  const res = await cw.send(new GetMetricStatisticsCommand({ Namespace: "Dilaya/SqliteData", MetricName: "ReplicationLagMaxSeconds", Dimensions, StartTime: new Date(Date.now() - 20 * 60_000), EndTime: new Date(), Period: 60, Statistics: ["Maximum"] }));
  const values = (res.Datapoints ?? []).map((d) => d.Maximum);
  check(`cell ${cell}: ReplicationLagMaxSeconds is published, and ~100 mostly idle databases show no lag`, cell === "1" ? values.every((v) => v < 60) : values.length > 0 && values.every((v) => v < 60), `${values.length} datapoints, max ${Math.max(0, ...values).toFixed(1)} s`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
