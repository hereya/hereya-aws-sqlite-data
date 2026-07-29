// Acceptance: the org database quota, end to end against a DEPLOYED stack.
//
// Proves the four things that matter about a cap, in order:
//   1. under the cap, writes are untouched;
//   2. past the cap, the next write is refused with DB_QUOTA_EXCEEDED (429);
//   3. reading and freeing space keep working while refused (the way out is
//      never blocked);
//   4. lifting the cap unblocks the org within the measurement TTL.
//
// SAFETY: it operates on its OWN canary org (default `quota-canary-org`) and
// touches no tenant. It sets `maxDbMb` on that org's registry row and REMOVES
// the attribute again at the end, including on failure. Never point it at a
// real org id.
//
// Usage:
//   node scripts/acceptance/quota.mjs <dataApiUrl> <registryTable> [orgId] [appId]
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";

const [, , dataApiUrl, registryTable, orgId = "quota-canary-org", appId = "quota-canary-app"] =
  process.argv;
if (!dataApiUrl || !registryTable) {
  console.error("usage: quota.mjs <dataApiUrl> <registryTable> [orgId] [appId]");
  process.exit(2);
}
if (!orgId.includes("canary")) {
  console.error(`refusing to run against a non-canary org: ${orgId}`);
  process.exit(2);
}
const region = process.env.AWS_REGION ?? "eu-west-1";
const ddb = new DynamoDBClient({ region });

const q = (sql, params) =>
  signedCall(dataApiUrl, "/query", { org_id: orgId, app_id: appId, sql, params }, region);

async function setCap(mb) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: registryTable,
      Key: { org_id: { S: orgId }, sk: { S: "org" } },
      UpdateExpression: mb === null ? "REMOVE maxDbMb" : "SET maxDbMb = :v",
      ...(mb === null ? {} : { ExpressionAttributeValues: { ":v": { N: String(mb) } } }),
    }),
  );
  console.log(mb === null ? "cap lifted" : `cap set to ${mb} MB`);
}

function fail(step, detail) {
  console.error(`FAIL — ${step}`, detail);
  process.exitCode = 1;
  throw new Error(step);
}

/** The cap is read with a short TTL and usage re-measured on a TTL of its own;
 *  give both room rather than racing them. */
const settle = (ms = 8000) => new Promise((r) => setTimeout(r, ms));

try {
  // 0. registry rows (idempotent): the app, and an org row to hang the cap on
  await ddb.send(
    new PutItemCommand({
      TableName: registryTable,
      Item: {
        org_id: { S: orgId },
        sk: { S: `app#${appId}` },
        appId: { S: appId },
        name: { S: appId },
        status: { S: "active" },
        created_at: { S: new Date().toISOString() },
      },
    }),
  );
  await ddb.send(
    new PutItemCommand({
      TableName: registryTable,
      Item: { org_id: { S: orgId }, sk: { S: "org" }, status: { S: "active" } },
    }),
  );
  await setCap(null); // start from a known-uncapped state
  await settle();

  // 1. uncapped: a write goes through
  let res = await q("CREATE TABLE IF NOT EXISTS pad (id INTEGER PRIMARY KEY, blob TEXT)");
  if (res.status !== 200) fail("CREATE while uncapped", res);
  res = await q("DELETE FROM pad");
  if (res.status !== 200) fail("DELETE while uncapped", res);

  // grow the file past 1 MB (and past SQLite's WAL auto-checkpoint, so the
  // bytes land in the main file, which is what the quota measures)
  for (let i = 0; i < 16; i += 1) {
    res = await q("INSERT INTO pad (blob) VALUES (:b)", [
      { name: "b", value: { stringValue: "x".repeat(400 * 1024) } },
    ]);
    if (res.status !== 200) fail(`padding insert #${i}`, res);
  }
  console.log("padded past 1 MB while uncapped — writes unaffected");

  // 2. cap below current usage: the next write is refused
  await setCap(1);
  await settle();
  res = await q("INSERT INTO pad (blob) VALUES ('over')");
  if (res.status !== 429 || res.body?.error?.code !== "DB_QUOTA_EXCEEDED") {
    fail("write past the cap was NOT refused", res);
  }
  console.log(`refused as expected: ${res.body.error.message}`);

  // 3. the way out stays open
  res = await q("SELECT COUNT(*) AS n FROM pad");
  if (res.status !== 200) fail("SELECT while over the cap", res);
  console.log(`still readable: ${res.body.records[0][0].longValue} row(s)`);
  res = await q("DELETE FROM pad");
  if (res.status !== 200) fail("DELETE while over the cap", res);
  res = await q("VACUUM");
  if (res.status !== 200) fail("VACUUM while over the cap", res);
  console.log("DELETE + VACUUM accepted while over the cap");

  // 4. lifting the cap unblocks the org
  await setCap(null);
  await settle();
  res = await q("INSERT INTO pad (blob) VALUES ('back')");
  if (res.status !== 200) fail("write after the cap was lifted", res);
  console.log("write accepted again after the cap was lifted");

  console.log("quota acceptance OK");
} finally {
  // never leave a cap behind on the canary org
  await setCap(null).catch((err) => console.error("cleanup failed", err));
}
