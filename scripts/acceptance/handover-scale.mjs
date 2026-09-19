// Handover trial AT PROD SCALE (t_handover_catchup_parallel).
//
// The first trial stack carried a handful of databases and announced a ~17 s
// cut; prod, with 100, measured 227 s. Both terms that blew up are linear in
// the number of apps, so a trial that does not carry prod's count measures
// nothing. This script seeds the count, probes the cut, and reads the journal.
//
//   node scripts/acceptance/handover-scale.mjs seed    <stack> [apps=100]
//   node scripts/acceptance/handover-scale.mjs probe   <stack> [seconds=900]
//   node scripts/acceptance/handover-scale.mjs journal <stack> [instanceId] [sinceMinutes=30]
//   node scripts/acceptance/handover-scale.mjs drain   <stack>
//   node scripts/acceptance/handover-scale.mjs writes  <stack> [seconds=600] [apps=30]
//   node scripts/acceptance/handover-scale.mjs verify  <stack>
//
// `probe` runs a real statement, NOT /health: /health answers 200 while draining.
// `drain` restarts the service in place and reports drain-start → drain-complete
// from the journal — the departing side's cost, which dies with the VM on a
// real roll and so cannot be read there.
// (A "hung predecessor" cannot be staged with SIGSTOP: systemd follows its
// SIGTERM with a SIGCONT, so the frozen service wakes up and drains cleanly —
// tried 2026-09-19. To re-restore EVERY app, write to all of them instead:
// `writes <stack> 300 100` during a roll makes all 100 dirty.)
// `writes` keeps writing to N apps THROUGH the roll and records every write the
// API acknowledged; `verify` then demands each one back. That is the only proof
// that matters for a catch-up that deletes files: nothing acknowledged is lost.
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signedCall } from "./signed-call.mjs";
import { asgInstanceId, awsJson, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , mode, stackName, arg1, arg2] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
if (!mode || !stackName) {
  console.error("usage: handover-scale.mjs seed|probe|journal|drain <stack> [...]");
  process.exit(2);
}
if (/prod|p-263b1e67|p-c3fb06fc/i.test(stackName)) throw new Error("refusing to run against a production stack");
const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const ORG = "scale-org";

async function ssm(instanceId, commands) {
  const cmd = awsJson([
    "ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript",
    "--parameters", JSON.stringify({ commands }), "--region", region,
  ]);
  const id = cmd.Command.CommandId;
  const read = () => awsJson(["ssm", "get-command-invocation", "--command-id", id, "--instance-id", instanceId, "--region", region]);
  await waitFor("SSM command done", () => ["Success", "Failed"].includes(read().Status), { timeoutMs: 180_000, intervalMs: 3000 });
  return read().StandardOutputContent;
}

// Anchored on the event NAME: a bare "handover" also matches every litestream
// line of a stack whose bucket is called …-handover-….
const EVENTS = '"event":"(drain-|boot-|catchup|await-|observed|predecessor|launch-hook|ready|warming|proceeding|checkpoint|handover|published|ack)';
const journalCmd = (since) =>
  `journalctl -u dilaya-data-api --since '${since} min ago' -o short-iso-precise --no-pager | grep -E '${EVENTS}' | tail -120`;

if (mode === "seed") {
  const total = Number(arg1 ?? 100);
  const ddb = new DynamoDBClient({ region });
  const ids = Array.from({ length: total }, (_, i) => `scale-${String(i).padStart(3, "0")}`);
  let cursor = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const appId = ids[cursor++];
      if (appId === undefined) return;
      await ddb.send(new PutItemCommand({
        TableName: outputs.registryTableName,
        Item: {
          org_id: { S: ORG }, sk: { S: `app#${appId}` }, appId: { S: appId }, name: { S: appId },
          status: { S: "active" }, created_at: { S: new Date().toISOString() },
        },
      }));
      // A WRITE, not just a row: an app never written is "fresh" and is left
      // out of replication — it would cost nothing at restore, unlike prod's.
      for (const sql of ["CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)", `INSERT OR REPLACE INTO t VALUES ('seed','${appId}')`]) {
        const res = await signedCall(api, "/query", { org_id: ORG, app_id: appId, sql }, region);
        if (res.status !== 200) { failed++; console.error(appId, res.status, JSON.stringify(res.body)); break; }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`seeded ${total - failed}/${total} apps in ${ORG}`);
  process.exit(failed ? 1 : 0);
}

if (mode === "probe") {
  const until = Date.now() + Number(arg1 ?? 900) * 1000;
  let downSince = null;
  const cuts = [];
  while (Date.now() < until) {
    const t = Date.now();
    let ok = false;
    try {
      ok = (await Promise.race([signedCall(api, "/query", { org_id: ORG, app_id: "scale-000", sql: "SELECT 1" }, region), new Promise((_, r) => setTimeout(() => r(new Error("t/o")), 4000))])).status === 200;
    } catch { ok = false; }
    if (!ok && downSince === null) { downSince = t; console.log(`${new Date(t).toISOString()} DOWN`); }
    if (ok && downSince !== null) {
      cuts.push({ from: new Date(downSince).toISOString(), to: new Date(t).toISOString(), seconds: (t - downSince) / 1000 });
      console.log(`${new Date(t).toISOString()} UP after ${(t - downSince) / 1000}s`);
      downSince = null;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - t))));
  }
  console.log(JSON.stringify({ cuts, stillDown: downSince !== null }, null, 2));
  process.exit(0);
}

if (mode === "journal") {
  const instanceId = arg1 && arg1.startsWith("i-") ? arg1 : asgInstanceId(stackName, region).instanceId;
  console.log(`--- ${instanceId} ---\n${await ssm(instanceId, [journalCmd(Number(arg2 ?? 30))])}`);
  process.exit(0);
}

if (mode === "drain") {
  const { instanceId } = asgInstanceId(stackName, region);
  if (!instanceId) throw new Error("no in-service instance");
  console.log(`restarting dilaya-data-api on ${instanceId} (in place, no ASG event) ...`);
  const out = await ssm(instanceId, ["systemctl restart dilaya-data-api", "sleep 5", journalCmd(5)]);
  console.log(out);
  const at = (event) => {
    const line = out.split("\n").reverse().find((l) => l.includes(`"${event}"`));
    return line ? Date.parse(line.split(" ")[0]) : NaN;
  };
  console.log(JSON.stringify({ drainSeconds: (at("drain-complete") - at("drain-start")) / 1000 }));
  process.exit(0);
}

const ACKED = process.env.ACKED_FILE ?? join(tmpdir(), `handover-scale-${stackName}-acked.json`);
const appAt = (i) => `scale-${String(i).padStart(3, "0")}`;

if (mode === "writes") {
  const until = Date.now() + Number(arg1 ?? 600) * 1000;
  const apps = Number(arg2 ?? 30);
  const acked = {};
  let refused = 0;
  for (let n = 0; Date.now() < until; n++) {
    const appId = appAt(n % apps);
    const key = `w-${Date.now()}`;
    let status = 0;
    try {
      status = (await signedCall(api, "/query", { org_id: ORG, app_id: appId, sql: `INSERT INTO t VALUES ('${key}','x')` }, region)).status;
    } catch { /* a refused write is fine; an acknowledged one that vanishes is not */ }
    if (status === 200) (acked[appId] ??= []).push(key);
    else refused++;
    if (n % 20 === 0) writeFileSync(ACKED, JSON.stringify(acked));
    await new Promise((r) => setTimeout(r, 100));
  }
  writeFileSync(ACKED, JSON.stringify(acked));
  console.log(JSON.stringify({ acknowledged: Object.values(acked).flat().length, refused, file: ACKED }));
  process.exit(0);
}

if (mode === "verify") {
  const acked = JSON.parse(readFileSync(ACKED, "utf8"));
  let lost = 0;
  let checked = 0;
  for (const [appId, keys] of Object.entries(acked)) {
    const res = await signedCall(api, "/query", { org_id: ORG, app_id: appId, sql: "SELECT k FROM t WHERE k LIKE 'w-%'" }, region);
    if (res.status !== 200) throw new Error(`${appId}: ${res.status}`);
    const present = new Set(res.body.records.map((r) => r[0].stringValue));
    for (const k of keys) { checked++; if (!present.has(k)) { lost++; console.error(`LOST ${appId} ${k}`); } }
  }
  console.log(JSON.stringify({ checked, lost }));
  process.exit(lost ? 1 : 0);
}

throw new Error(`unknown mode: ${mode}`);
