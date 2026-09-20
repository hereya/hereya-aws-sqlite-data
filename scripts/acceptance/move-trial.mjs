// Moving databases between two REAL cells (t_dbmove_p4_move) — throwaway stack,
// vmCount=2, seeded at prod scale first:
//
//   node scripts/acceptance/handover-scale.mjs seed <stack> 100
//   node scripts/acceptance/move-trial.mjs <stack> [crash]
//
// What no test can see: the role really may UpdateItem `_placement` (and nothing
// else), litestream's per-database stop really leaves S3 complete, the target
// really continues the same replica path, and — `crash` — a process killed at
// EACH step of a move leaves the app with ONE writer and every acknowledged row.
// `crash` arms MOVE_CRASH_POINTS on both instances (a systemd drop-in, by SSM).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";
import { awsJson, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName, extra] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
if (!stackName) throw new Error("usage: move-trial.mjs <stack> [crash]");
if (/prod|p-263b1e67|p-c3fb06fc/i.test(stackName)) throw new Error("refusing to run against a production stack");

const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const table = outputs.registryTableName;
const bucket = outputs.sqliteReplicaBucketName;
const ddb = new DynamoDBClient({ region });
const ORG = "scale-org"; // seeded by handover-scale.mjs: scale-000 … scale-099, table t(k, v), on cell 0
const app = (n) => `scale-${String(n).padStart(3, "0")}`;
// First app of the ten that get moved — a second run on the same stack needs ten apps still on cell 0.
const FIRST = Number(process.env.MOVE_FIRST ?? 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const timed = (p, ms = 12_000) => Promise.race([p, sleep(ms).then(() => ({ status: 0, body: null }))]).catch(() => ({ status: 0, body: null }));
const query = (appId, sql) => timed(signedCall(api, "/query", { org_id: ORG, app_id: appId, sql }, region));
const move = (appId, toCell, more = {}) => timed(signedCall(api, "/admin/move-app", { org_id: ORG, app_id: appId, to_cell: toCell, ...more }, region), 35_000);
const row = async (appId) => {
  const item = (await ddb.send(new GetItemCommand({ TableName: table, Key: { org_id: { S: "_placement" }, sk: { S: `${ORG}/${appId}` } }, ConsistentRead: true }))).Item;
  return item ? { vmId: item.vmId?.S, version: Number(item.version?.N), phase: item.phase?.S ?? null, targetVm: item.targetVm?.S ?? null } : null;
};

// ASYNC on purpose: the helpers' execFileSync blocks this process for seconds, and
// the writers live in it — the first run read that as a 5 s outage of every bystander.
const run = promisify(execFile);
const awsAsync = async (args) => JSON.parse((await run("aws", [...args, "--output", "json"])).stdout || "null");
async function ssm(instanceId, commands) {
  const id = (await awsAsync(["ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands }), "--region", region])).Command.CommandId;
  const read = () => awsAsync(["ssm", "get-command-invocation", "--command-id", id, "--instance-id", instanceId, "--region", region]);
  await waitFor("SSM command done", async () => ["Success", "Failed"].includes((await read()).Status), { timeoutMs: 180_000, intervalMs: 3000 });
  return (await read()).StandardOutputContent.trim();
}
async function instances() {
  const asgs = awsJson(["autoscaling", "describe-auto-scaling-groups", "--region", region]).AutoScalingGroups.filter((g) =>
    g.Tags?.some((t) => t.Key === "aws:cloudformation:stack-name" && t.Value === stackName));
  const out = {};
  for (const g of asgs) {
    const id = g.Instances.find((i) => i.LifecycleState === "InService")?.InstanceId;
    if (id) out[(await ssm(id, ["grep ^CELL_ID= /etc/dilaya/data-api.env | cut -d= -f2"])) || "0"] = id;
  }
  return out;
}
const cells = await instances();
check("two cells in service", Boolean(cells["0"] && cells["1"]), JSON.stringify(cells));
const hasFile = (cell, appId) => ssm(cells[cell], [`test -f /var/lib/dilaya/dbs/${ORG}/${appId}/app.db && echo yes || echo no`]).then((o) => o === "yes");
/** The dual-writer check: which cells' litestream daemons WATCH this database right now. */
const watchers = async (appId) => {
  const out = [];
  for (const cell of ["0", "1"]) {
    const n = await ssm(cells[cell], [`sudo -u dataapi /usr/local/bin/litestream list -socket /etc/dilaya/litestream.sock 2>/dev/null | grep -c '/${ORG}/${appId}/' || true`]);
    if (Number(n) > 0) out.push(cell);
  }
  return out;
};
/** What S3 holds, read by a restore that touches no service: count of rows in t. */
const rowsInS3 = (appId) =>
  ssm(cells["0"], [
    `rm -rf /tmp/mt && mkdir -p /tmp/mt && /usr/local/bin/litestream restore -o /tmp/mt/x.db s3://${bucket}/${ORG}/${appId}/app.db >/dev/null 2>&1`,
    `/opt/dilaya/node/bin/node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/tmp/mt/x.db',{readOnly:true});console.log(d.prepare('SELECT count(*) c FROM t').get().c)"`,
  ]).then(Number);

/** Write one row every ~100 ms until stopped; remembers what was ACKNOWLEDGED and the longest silence. */
function writer(appId, tag) {
  const state = { acked: [], errors: {}, maxGapMs: 0, stop: false };
  let last = Date.now();
  state.done = (async () => {
    for (let i = 0; !state.stop; i++) {
      const res = await query(appId, `INSERT OR REPLACE INTO t VALUES ('${tag}-${i}', 'x')`);
      if (res.status === 200) {
        state.acked.push(`${tag}-${i}`);
        state.maxGapMs = Math.max(state.maxGapMs, Date.now() - last);
        last = Date.now();
      } else {
        // A 5xx without `error.code` was answered by the GATEWAY alone (integrationLatency 0 in its access log).
        const who = res.body?.error?.code ? `${res.status}:${res.body.error.code}` : `${res.status}:gateway`;
        state.errors[who] = (state.errors[who] ?? 0) + 1;
      }
      await sleep(100);
    }
  })();
  return state;
}
async function missing(appId, keys) {
  // Retried: one gateway 503 here would read as "every row lost".
  let res = await query(appId, "SELECT k FROM t");
  for (let i = 0; res.status !== 200 && i < 10; i++) { await sleep(1000); res = await query(appId, "SELECT k FROM t"); }
  if (res.status !== 200) return keys;
  const have = new Set(res.body.records.map((r) => r[0].stringValue));
  return keys.filter((k) => !have.has(k));
}

// 1. ten moves under load, bystanders written throughout
const bystanders = [90, 91, 92, 93, 94].map((n) => writer(app(n), "by"));
const pauses = [];
const gaps = [];
for (let n = FIRST; n < FIRST + 10; n++) {
  const w = writer(app(n), `m${n}`);
  await sleep(1500);
  const res = await move(app(n), "1");
  await sleep(1500);
  w.stop = true;
  await w.done;
  const lost = await missing(app(n), w.acked);
  const ok = res.status === 200 && res.body.status === "moved" && lost.length === 0 && Object.keys(w.errors).every((k) => k.endsWith(":gateway"));
  if (ok) { pauses.push(res.body.pauseMs); gaps.push(w.maxGapMs); }
  check(`${app(n)} moved to cell 1 under load: nothing refused by the service, every acknowledged write read back`, ok, `pause ${res.body?.pauseMs} ms, longest client silence ${w.maxGapMs} ms, acked ${w.acked.length}, lost ${lost.length}, errors ${JSON.stringify(w.errors)}, ${res.status} ${JSON.stringify(res.body)}`);
}
console.log(JSON.stringify({ pausesMs: pauses, clientGapsMs: gaps }));
const r10 = await row(app(FIRST));
check("the row is finalized: vmId=1, no phase left", r10?.vmId === "1" && r10.phase === null, JSON.stringify(r10));
check("the file is on cell 1 and NOT under the org on cell 0", (await hasFile("1", app(FIRST))) && !(await hasFile("0", app(FIRST))));
check("cell 0 set its copy aside under _moved/", Number(await ssm(cells["0"], ["ls /var/lib/dilaya/dbs/_moved | wc -l"])) >= 10);
check("ONE litestream watches it: cell 1", (await watchers(app(FIRST))).join() === "1");

// 2. and back — the target has a history with this app (a stale copy must never be served)
const back = writer(app(FIRST), "back");
await sleep(1000);
const resBack = await move(app(FIRST), "0");
await sleep(1000);
back.stop = true;
await back.done;
check(`${app(FIRST)} moved BACK to cell 0, nothing lost`, resBack.body?.status === "moved" && (await missing(app(FIRST), back.acked)).length === 0, JSON.stringify(resBack.body));
check("ONE litestream watches it: cell 0", (await watchers(app(FIRST))).join() === "0");

// 3. an open transaction: the move gives up, the transaction commits
const tx = await timed(signedCall(api, "/tx/begin", { org_id: ORG, app_id: app(30) }, region));
const refused = await move(app(30), "1");
check("open transaction → 409 MOVE_ABORTED", refused.status === 409 && refused.body?.error?.code === "MOVE_ABORTED", JSON.stringify(refused.body));
const commit = await timed(signedCall(api, "/tx/commit", { org_id: ORG, app_id: app(30), transactionId: tx.body?.transactionId }, region));
check("… and the transaction commits", commit.status === 200);

for (const b of bystanders) b.stop = true;
await Promise.all(bystanders.map((b) => b.done));
check("bystanders: the SERVICE refused them nothing", bystanders.every((b) => Object.keys(b.errors).every((k) => k.endsWith(":gateway"))), JSON.stringify(bystanders.map((b) => ({ acked: b.acked.length, errors: b.errors, maxGapMs: b.maxGapMs }))));
check("S3 holds every row of a moved database (restore, no service involved)", (await rowsInS3(app(FIRST + 1))) === Number((await query(app(FIRST + 1), "SELECT count(*) FROM t")).body.records[0][0].longValue));

if (extra === "crash") {
  for (const cell of ["0", "1"]) {
    await ssm(cells[cell], ["mkdir -p /etc/systemd/system/dilaya-data-api.service.d", "printf '[Service]\\nEnvironment=MOVE_CRASH_POINTS=on\\n' > /etc/systemd/system/dilaya-data-api.service.d/crash.conf", "systemctl daemon-reload && systemctl restart dilaya-data-api"]);
  }
  await waitFor("both cells answer again", async () => (await query(app(0), "SELECT 1")).status === 200 && (await query(app(FIRST + 1), "SELECT 1")).status === 200, { timeoutMs: 180_000, intervalMs: 2000 });
  // [crash point, the cell that must hold the app afterwards]
  const points = [["after-begin", "0"], ["after-detach", "0"], ["after-a-stopped", "0"], ["after-ask", "1"], ["in-after-clear", "0"], ["in-after-claim", "1"], ["in-after-restore", "1"]];
  let n = Number(process.env.CRASH_FIRST ?? 40);
  const crashFirst = n;
  for (const [point, expected] of points) {
    const appId = app(n++);
    const w = writer(appId, point);
    await sleep(1200);
    const res = await move(appId, "1", { crash_at: point });
    const crashedAt = Date.now();
    await sleep(1500);
    // The writer kept going through the crash: whatever it was told "200" must exist.
    const backMs = await waitFor(`${appId} answers again`, async () => (await query(appId, "SELECT 1")).status === 200, { timeoutMs: 240_000, intervalMs: 1000 }).catch(() => -1);
    await sleep(2000);
    w.stop = true;
    await w.done;
    const lost = await missing(appId, w.acked);
    const r = await row(appId);
    const holder = r === null ? "0" : r.phase === "b_started" ? r.targetVm : r.vmId;
    // A restarted cell starts its daemon AFTER it is ready: give the listing its chance.
    let seenBy = await watchers(appId);
    for (let i = 0; seenBy.join() !== expected && i < 6; i++) { await sleep(5000); seenBy = await watchers(appId); }
    const inS3 = await rowsInS3(appId);
    const served = Number((await query(appId, "SELECT count(*) FROM t")).body?.records?.[0]?.[0]?.longValue);
    check(`crash ${point}: held by cell ${expected}, ONE writer, nothing acknowledged is lost`,
      holder === expected && seenBy.join() === expected && lost.length === 0 && backMs >= 0,
      `move → ${res.status} ${JSON.stringify(res.body)}; back after ${(Date.now() - crashedAt - 2000) / 1000 | 0} s; row ${JSON.stringify(r)}; watched by [${seenBy}]; acked ${w.acked.length}, lost ${lost.length}, errors ${JSON.stringify(w.errors)}`);
    check(`crash ${point}: S3 agrees with what is served`, inS3 === served, `s3 ${inS3}, served ${served}`);
  }
  await sleep(35_000); // one registry poll: the sweep must have settled every row
  const left = [];
  for (let i = crashFirst; i < n; i++) if ((await row(app(i)))?.phase) left.push(app(i));
  check("no row is left mid-move once both cells have swept", left.length === 0, left.join());
}

console.log(failures === 0 ? "\nMOVE TRIAL: PASS" : `\nMOVE TRIAL: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
