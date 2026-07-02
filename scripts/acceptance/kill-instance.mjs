// Spec §13 acceptance: terminate the EC2 instance manually → a new instance
// serves ALL apps again without intervention, with data intact.
//   node scripts/acceptance/kill-instance.mjs <stackName>
import { signedCall } from "./signed-call.mjs";
import { asgInstanceId, aws, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName = "dilaya-sqlite-dev"] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
const orgId = "canary-org";
const appId = "canary-app";

const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
if (!api) throw new Error("stack has no dataApiUrl output");

const q = (sql, params) => signedCall(api, "/query", { org_id: orgId, app_id: appId, sql, params }, region);

// 0. baseline: canary data must exist (run canary.mjs first) and be readable
const before = await q("SELECT COUNT(*) AS total FROM canary");
if (before.status !== 200) throw new Error(`baseline read failed: ${JSON.stringify(before)}`);
const countBefore = before.body.records[0][0].longValue;
console.log(`baseline: ${countBefore} canary row(s)`);

// 1. terminate the instance WITHOUT decrementing capacity
const { instanceId } = asgInstanceId(stackName, region);
if (!instanceId) throw new Error("no in-service instance to kill");
console.log(`terminating ${instanceId} ...`);
aws([
  "ec2", "terminate-instances",
  "--instance-ids", instanceId,
  "--region", region,
]);
const t0 = Date.now();

// 2. wait for the API to come back with the SAME data (loss window aside)
const recoveredIn = await waitFor(
  "API recovered with canary data",
  async () => {
    const res = await q("SELECT COUNT(*) AS total FROM canary");
    return res.status === 200 && res.body.records[0][0].longValue >= countBefore;
  },
  { timeoutMs: 10 * 60_000, intervalMs: 10_000 },
);

const { instanceId: newId } = asgInstanceId(stackName, region);
console.log(
  `RECOVERED in ${Math.round((Date.now() - t0) / 1000)}s (poll granularity 10s): ` +
    `new instance ${newId}, canary rows intact (${countBefore})`,
);
if (newId === instanceId) throw new Error("instance id did not change — ASG did not replace it?");
console.log(`kill-instance acceptance PASSED (${Math.round(recoveredIn / 1000)}s to recovery)`);
