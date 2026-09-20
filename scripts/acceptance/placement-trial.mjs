// Placement trial on a throwaway stack (t_dbmove_p2_placement).
//
// What no unit test can see — the joints between the service and AWS:
//   1. the instance role really allows the strongly consistent Query of `_placement`
//      (a refusal would abort the BOOT, i.e. every org's databases);
//   2. Cloud Map accepts the custom `DILAYA_CELL` attribute on a DNS-backed service;
//   3. placing an app elsewhere makes this cell let go of it (421, file gone), without
//      disturbing the others; removing the row brings it back FROM S3 with its data.
//
//   node scripts/acceptance/handover-scale.mjs seed <stack> 100     (first)
//   node scripts/acceptance/placement-trial.mjs <stack>
import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";
import { awsJson, stackOutputs } from "./stack-info.mjs";

const [, , stackName] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
if (!stackName) throw new Error("usage: placement-trial.mjs <stack>");
if (/prod|p-263b1e67|p-c3fb06fc/i.test(stackName)) throw new Error("refusing to run against a production stack");

const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const ddb = new DynamoDBClient({ region });
const ORG = "scale-org";
const MOVED = "scale-007";
const BYSTANDER = "scale-008";
const key = { org_id: { S: "_placement" }, sk: { S: `${ORG}/${MOVED}` } };

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const query = (appId, sql) => signedCall(api, "/query", { org_id: ORG, app_id: appId, sql }, region);
const seedOf = async (appId) => {
  const res = await query(appId, "SELECT v FROM t WHERE k = 'seed'");
  return { status: res.status, value: res.body?.records?.[0]?.[0]?.stringValue, code: res.body?.error?.code };
};
const sync = async () => (await signedCall(api, "/admin/sync", {}, region)).body;

// 1. the boot survived the placement read, and every seeded app answers
const before = await seedOf(MOVED);
check("empty partition: the app is served by the origin cell", before.status === 200 && before.value === MOVED, JSON.stringify(before));
const marker = `p2-${Date.now()}`;
const wrote = await query(MOVED, `INSERT OR REPLACE INTO t VALUES ('marker','${marker}')`);
check("a write is acknowledged before the placement changes", wrote.status === 200);
await new Promise((r) => setTimeout(r, 3000)); // litestream sync-interval is 1 s

// 2. Cloud Map carries the cell
const serviceId = awsJson(["cloudformation", "describe-stack-resources", "--stack-name", stackName, "--region", region])
  .StackResources.find((r) => r.ResourceType === "AWS::ServiceDiscovery::Service")?.PhysicalResourceId;
if (serviceId) {
  const inst = awsJson(["servicediscovery", "list-instances", "--service-id", serviceId, "--region", region]).Instances ?? [];
  check("Cloud Map accepted the DILAYA_CELL attribute", inst.length === 1 && inst[0].Attributes?.DILAYA_CELL === "0", JSON.stringify(inst.map((i) => i.Attributes)));
} else {
  console.log("… no Cloud Map service id in the stack outputs; check the attribute by hand");
}

// 3. place the app on another cell
await ddb.send(new PutItemCommand({ TableName: outputs.registryTableName, Item: { ...key, vmId: { S: "1" }, version: { N: "1" } } }));
console.log("sync after placing elsewhere:", JSON.stringify(await sync()));
const away = await seedOf(MOVED);
// Since the relay (t_dbmove_p3_relay_cells) the 421 stays between VMs: with no cell 1
// in this stack the client is told 503 "no reachable instance", which it retries.
check("placed on cell 1, which does not exist here: 503 UNAVAILABLE, and the app is let go", away.status === 503 && away.code === "UNAVAILABLE", JSON.stringify(away));
const bystander = await seedOf(BYSTANDER);
check("the bystander never noticed", bystander.status === 200 && bystander.value === BYSTANDER, JSON.stringify(bystander));

// 4. a malformed row is one app's problem
await ddb.send(new PutItemCommand({ TableName: outputs.registryTableName, Item: { ...key, phase: { S: "moving" } } }));
await sync();
const broken = await seedOf(MOVED);
check("a row without vmId: that app is 503, not served and not 'the origin's'", broken.status === 503, JSON.stringify(broken));
check("… and the rest of the cell keeps serving", (await seedOf(BYSTANDER)).status === 200);

// 5. back to the origin: restored FROM S3, data intact
await ddb.send(new DeleteItemCommand({ TableName: outputs.registryTableName, Key: key }));
console.log("sync after removing the row:", JSON.stringify(await sync()));
const back = await query(MOVED, "SELECT v FROM t WHERE k = 'marker'");
const got = back.body?.records?.[0]?.[0]?.stringValue;
check("row removed: the app is back, restored from S3 with the acknowledged write", back.status === 200 && got === marker, `${back.status} ${got}`);

console.log(failures === 0 ? "\nPLACEMENT TRIAL: PASS" : `\nPLACEMENT TRIAL: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
