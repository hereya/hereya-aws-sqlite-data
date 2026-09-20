// Two REAL cells behind one gateway (t_dbmove_p3_relay_cells) — throwaway stack,
// deployed with vmCount=2 and seeded at prod scale first:
//
//   node scripts/acceptance/handover-scale.mjs seed <stack> 100
//   node scripts/acceptance/cells-trial.mjs <stack> [kill]
//
// What no test can see: the security group really lets one VM reach the other,
// the role really may write `_vms`, the gateway really spreads over both
// registrations, and a dead cell really gets evicted by its peer.
// `kill` terminates cell 1's instance and measures what each org sees.
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";
import { aws, awsJson, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName, extra] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
if (!stackName) throw new Error("usage: cells-trial.mjs <stack> [kill]");
if (/prod|p-263b1e67|p-c3fb06fc/i.test(stackName)) throw new Error("refusing to run against a production stack");

const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const table = outputs.registryTableName;
const ddb = new DynamoDBClient({ region });
const ORIGIN_ORG = "scale-org"; // seeded by handover-scale.mjs, no placement row → cell 0
const CELL1_ORG = process.env.CELL1_ORG ?? "cell1-org"; // placed on cell 1 by an ORG row, before its first database
const CELL1_APPS = Array.from({ length: 10 }, (_, i) => `c1-${String(i).padStart(2, "0")}`);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const query = (orgId, appId, sql) => signedCall(api, "/query", { org_id: orgId, app_id: appId, sql }, region);
const vms = async () =>
  ((await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "org_id = :p", ExpressionAttributeValues: { ":p": { S: "_vms" } }, ConsistentRead: true }))).Items ?? []).map((i) => ({
    cellId: i.sk.S.split("/")[0], instanceId: i.sk.S.split("/")[1], ip: i.ip?.S, state: i.state?.S, beat: Number(i.beat?.N),
  }));
const serving = async (cellId) => (await vms()).filter((v) => v.cellId === cellId && v.state === "serving");

async function ssm(instanceId, commands) {
  const id = awsJson(["ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands }), "--region", region]).Command.CommandId;
  const read = () => awsJson(["ssm", "get-command-invocation", "--command-id", id, "--instance-id", instanceId, "--region", region]);
  await waitFor("SSM command done", () => ["Success", "Failed"].includes(read().Status), { timeoutMs: 120_000, intervalMs: 3000 });
  return read().StandardOutputContent.trim();
}
const journalCount = (instanceId, pattern) =>
  ssm(instanceId, [`journalctl -u dilaya-data-api --since '20 min ago' --no-pager | grep -c '${pattern}' || true`]).then(Number);

// 1. both cells are in discovery AND in the directory
const serviceId = awsJson(["cloudformation", "describe-stack-resources", "--stack-name", stackName, "--region", region])
  .StackResources.find((r) => r.ResourceType === "AWS::ServiceDiscovery::Service").PhysicalResourceId;
const registered = awsJson(["servicediscovery", "list-instances", "--service-id", serviceId, "--region", region]).Instances ?? [];
check("Cloud Map: one registration per cell", registered.map((i) => i.Attributes.DILAYA_CELL).sort().join() === "0,1", JSON.stringify(registered.map((i) => i.Attributes)));
const rows = await vms();
check("`_vms`: both cells announced themselves (the role may PutItem there)", rows.filter((r) => r.state === "serving").map((r) => r.cellId).sort().join() === "0,1", JSON.stringify(rows));
const [cell0] = await serving("0");
const [cell1] = await serving("1");
const beatBefore = cell1?.beat;

// 2. a NEW org placed on cell 1 by ONE row, then its databases are born there
await ddb.send(new PutItemCommand({ TableName: table, Item: { org_id: { S: "_placement" }, sk: { S: CELL1_ORG }, vmId: { S: "1" }, version: { N: "1" } } }));
await signedCall(api, "/admin/sync", {}, region);
await new Promise((r) => setTimeout(r, 1000));
let seedFailures = 0;
for (const appId of CELL1_APPS) {
  await ddb.send(new PutItemCommand({ TableName: table, Item: { org_id: { S: CELL1_ORG }, sk: { S: `app#${appId}` }, appId: { S: appId }, name: { S: appId }, status: { S: "active" }, created_at: { S: new Date().toISOString() } } }));
  for (const sql of ["CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)", `INSERT OR REPLACE INTO t VALUES ('seed','${appId}')`]) {
    const res = await query(CELL1_ORG, appId, sql);
    if (res.status !== 200) { seedFailures++; console.error(appId, res.status, JSON.stringify(res.body)); }
  }
}
check("10 apps created in the org placed on cell 1 — through whichever cell the gateway picked", seedFailures === 0);

// 3. the files are where placement says, and NOWHERE else
const count = (instanceId, org) => ssm(instanceId, [`ls /var/lib/dilaya/dbs/${org} 2>/dev/null | wc -l`]).then(Number);
check("cell 1 holds the 10 new databases", (await count(cell1.instanceId, CELL1_ORG)) === 10);
check("cell 0 holds none of them (it relayed, it never restored)", (await count(cell0.instanceId, CELL1_ORG)) === 0);
check("cell 1 holds none of the origin's 100", (await count(cell1.instanceId, ORIGIN_ORG)) === 0);

// 4. 400 reads over both orgs: every one answers, whichever cell it landed on
const lat = [];
let bad = 0;
for (let n = 0; n < 400; n++) {
  const [org, app] = n % 2 ? [CELL1_ORG, CELL1_APPS[n % 10]] : [ORIGIN_ORG, `scale-${String(n % 100).padStart(3, "0")}`];
  const t = Date.now();
  const res = await query(org, app, "SELECT v FROM t WHERE k = 'seed'");
  lat.push(Date.now() - t);
  if (res.status !== 200 || res.body.records[0][0].stringValue !== app) { bad++; console.error(org, app, res.status, JSON.stringify(res.body)); }
}
lat.sort((a, b) => a - b);
check("400 reads across both orgs: all correct", bad === 0, `p50 ${lat[200]} ms, p95 ${lat[380]} ms (client-side, SigV4 + gateway included)`);
const relayedBy0 = await journalCount(cell0.instanceId, "RELAYED_1");
const relayedBy1 = await journalCount(cell1.instanceId, "RELAYED_0");
check("the relay ran BOTH ways (the gateway spreads over both cells)", relayedBy0 > 0 && relayedBy1 > 0, `cell0→1: ${relayedBy0}, cell1→0: ${relayedBy1}`);
check("no request crossed twice", (await journalCount(cell0.instanceId, '"code":"MISPLACED"')) + (await journalCount(cell1.instanceId, '"code":"MISPLACED"')) === 0);
const beatAfter = (await serving("1"))[0]?.beat;
check("cell 1's counter moves", beatAfter > beatBefore, `${beatBefore} → ${beatAfter}`);

if (extra === "kill") {
  // 5. cell 1 dies without a word. 1/2 of ALL traffic goes to a dead address
  // until someone removes it — and the only one there is cell 0.
  // ⚠️ NOT `ec2 terminate-instances`: that is a clean shutdown — systemd SIGTERMs the
  // service, which drains, deregisters and retires its row (tried first: the origin's
  // org saw 3 errors in 10 s and nobody had anything to evict). A crash says nothing:
  // sysrq "o" powers the machine off at once, with no shutdown script.
  console.log(`crashing ${cell1.instanceId} (cell 1): immediate power-off, no drain ...`);
  aws(["ssm", "send-command", "--instance-ids", cell1.instanceId, "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands: ["echo 1 > /proc/sys/kernel/sysrq; (sleep 2; echo o > /proc/sysrq-trigger) &"] }), "--region", region]);
  await new Promise((r) => setTimeout(r, 4000));
  const killedAt = Date.now();
  const seen = { origin: { ok: 0, ko: 0, lastKo: 0 }, cell1: { ok: 0, ko: 0, firstOk: 0 } };
  let evictedAt = 0;
  while (Date.now() - killedAt < 420_000) {
    const t = Date.now();
    const timed = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: 0 }), 4000))]).catch(() => ({ status: 0 }));
    const [o, c] = await Promise.all([timed(query(ORIGIN_ORG, "scale-000", "SELECT 1")), timed(query(CELL1_ORG, CELL1_APPS[0], "SELECT 1"))]);
    if (o.status === 200) seen.origin.ok++; else { seen.origin.ko++; seen.origin.lastKo = t - killedAt; }
    if (c.status === 200) { seen.cell1.ok++; if (seen.cell1.ko > 0 && !seen.cell1.firstOk) seen.cell1.firstOk = t - killedAt; } else seen.cell1.ko++;
    if (seen.cell1.firstOk && t - killedAt > seen.cell1.firstOk + 20_000) break;
    if (!evictedAt && (await vms()).some((v) => v.instanceId === cell1.instanceId && v.state === "evicted")) evictedAt = t - killedAt;
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - t))));
  }
  console.log(JSON.stringify({ evictedAfterS: evictedAt / 1000, originLastErrorS: seen.origin.lastKo / 1000, cell1BackAfterS: seen.cell1.firstOk / 1000, seen }, null, 2));
  check("cell 0 evicted its dead peer from discovery", evictedAt > 0, `${evictedAt / 1000} s after the kill`);
  check("the origin's org stopped seeing errors once the peer was evicted", seen.origin.lastKo <= evictedAt + 15_000, `last error at ${seen.origin.lastKo / 1000} s`);
  check("cell 1 came back on a new instance, restored from S3", seen.cell1.firstOk > 0, `${seen.cell1.firstOk / 1000} s`);
  const back = await query(CELL1_ORG, CELL1_APPS[3], "SELECT v FROM t WHERE k = 'seed'");
  check("… with its data", back.body?.records?.[0]?.[0]?.stringValue === CELL1_APPS[3]);
  const now = await vms();
  check("the new instance cleared its cell's leftovers from `_vms`", now.filter((v) => v.cellId === "1").length === 1, JSON.stringify(now));
}

console.log(failures === 0 ? "\nCELLS TRIAL: PASS" : `\nCELLS TRIAL: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
