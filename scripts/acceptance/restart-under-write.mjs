// The data-api PROCESS is killed while an app is being written, on a stack with
// the handover ON (t_handover_stale_ack_wipe) — throwaway stack, seeded first:
//
//   node scripts/acceptance/handover-scale.mjs seed <stack> 100
//   node scripts/acceptance/restart-under-write.mjs <stack>
//
// What it stages is what production looked like: an `_handover/ack` item naming
// the SERVING instance, left by the roll that brought it in. Before the fix the
// restarted process read it as a live predecessor, then "gone without a
// report", and re-restored everything — every local database deleted under
// traffic. What must hold now: the journal says `gate-skipped`, never
// `catchup-start`, and every acknowledged row is read back.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";
import { stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
if (!stackName) throw new Error("usage: restart-under-write.mjs <stack>");
if (/prod|p-263b1e67|p-c3fb06fc/i.test(stackName)) throw new Error("refusing to run against a production stack");

const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const ORG = "scale-org";
const APPS = ["scale-000", "scale-001", "scale-002"]; // origin cell, never moved
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const awsAsync = async (args) => JSON.parse((await run("aws", [...args, "--output", "json"])).stdout || "null");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const timed = (p, ms = 8000) => Promise.race([p, sleep(ms).then(() => ({ status: 0, body: null }))]).catch(() => ({ status: 0, body: null }));
const query = (appId, sql) => timed(signedCall(api, "/query", { org_id: ORG, app_id: appId, sql }, region));
async function ssm(instanceId, commands) {
  const id = (await awsAsync(["ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands }), "--region", region])).Command.CommandId;
  const read = () => awsAsync(["ssm", "get-command-invocation", "--command-id", id, "--instance-id", instanceId, "--region", region]);
  await waitFor("SSM command done", async () => ["Success", "Failed"].includes((await read()).Status), { timeoutMs: 180_000, intervalMs: 3000 });
  return (await read()).StandardOutputContent.trim();
}

// The origin cell's instance: the one whose env says CELL_ID=0 (a stack may have several cells).
let instanceId = null;
for (const g of (await awsAsync(["autoscaling", "describe-auto-scaling-groups", "--region", region])).AutoScalingGroups) {
  if (!g.Tags?.some((t) => t.Key === "aws:cloudformation:stack-name" && t.Value === stackName)) continue;
  const id = g.Instances.find((i) => i.LifecycleState === "InService")?.InstanceId;
  if (id && ((await ssm(id, ["grep ^CELL_ID= /etc/dilaya/data-api.env | cut -d= -f2"])) || "0") === "0") instanceId = id;
}
check("the origin cell has an instance in service", instanceId !== null, String(instanceId));
if (instanceId === null) process.exit(1);

// Production's item, verbatim shape: written by a predecessor that is long gone.
await new DynamoDBClient({ region }).send(new PutItemCommand({
  TableName: outputs.registryTableName,
  Item: { org_id: { S: "_handover" }, sk: { S: "ack" }, fromInstanceId: { S: "i-0deadpredecessor00" }, forInstanceId: { S: instanceId } },
}));

const writers = APPS.map((appId) => {
  const state = { appId, acked: [], errors: {}, stop: false };
  state.done = (async () => {
    for (let i = 0; !state.stop; i++) {
      const res = await query(appId, `INSERT OR REPLACE INTO t VALUES ('rs-${i}', 'x')`);
      if (res.status === 200) state.acked.push(`rs-${i}`);
      else {
        const who = res.body?.error?.code ? `${res.status}:${res.body.error.code}` : `${res.status}:gateway`;
        state.errors[who] = (state.errors[who] ?? 0) + 1;
      }
      await sleep(100);
    }
  })();
  return state;
});

await sleep(4000);
const since = new Date(Date.now() - 2000).toISOString().slice(11, 19);
console.log(`kill -9 of the data-api process on ${instanceId} ...`);
await ssm(instanceId, ["kill -9 $(systemctl show -p MainPID --value dilaya-data-api)"]);
const killedAt = Date.now();
await sleep(2000);
const backMs = await waitFor("the API answers again", async () => (await query(APPS[0], "SELECT 1")).status === 200, { timeoutMs: 180_000, intervalMs: 500 });
await sleep(20_000); // well past the old catch-up, with the writers still going
for (const w of writers) w.stop = true;
await Promise.all(writers.map((w) => w.done));

for (const w of writers) {
  let res = await query(w.appId, "SELECT k FROM t");
  for (let i = 0; res.status !== 200 && i < 10; i++) { await sleep(1000); res = await query(w.appId, "SELECT k FROM t"); }
  const have = new Set((res.body?.records ?? []).map((r) => r[0].stringValue));
  const lost = w.acked.filter((k) => !have.has(k));
  check(`${w.appId}: every acknowledged write survived the restart`, res.status === 200 && lost.length === 0, `acked ${w.acked.length}, lost ${lost.length}, errors ${JSON.stringify(w.errors)}`);
  check(`${w.appId}: no statement met a missing table (a file re-created empty)`, !Object.keys(w.errors).some((k) => k.includes("SQL_ERROR")));
}
const journal = await ssm(instanceId, [`journalctl -u dilaya-data-api --since '${since}' --no-pager -o cat | grep -E '"type":"handover"' | cut -c1-200 | head -30`]);
console.log(journal);
check("the restarted writer skipped the replacement's gate", journal.includes("gate-skipped"));
check("… and nothing was caught up (no local file deleted)", !/catchup-start|caught-up|predecessor-alive/.test(journal));
console.log(JSON.stringify({ backAfterS: (Date.now() - killedAt - 20_000) / 1000, waitedMs: backMs }));

console.log(failures === 0 ? "\nRESTART UNDER WRITE: PASS" : `\nRESTART UNDER WRITE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
