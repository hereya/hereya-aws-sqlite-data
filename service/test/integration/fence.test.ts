// End-to-end over the real HTTP surface: an org under a migration freeze has
// its DIRECT writes (a per-app Lambda's, the path the connector cannot see)
// refused with 503 ORG_MIGRATING + Retry-After, keeps reading, and writes again
// the moment it is unfrozen. Another org is never touched.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ORG_MIGRATING_MESSAGE } from "../../src/fence.ts";
import { call, startTestService, type TestService } from "../helpers.ts";

let svc: TestService;
const frozen = new Set<string>();

const A1 = { org_id: "org-a", app_id: "app-1" };
const B1 = { org_id: "org-b", app_id: "app-1" };

before(async () => {
  svc = await startTestService({}, { frozenOrgs: frozen });
  for (const pair of [A1, B1]) {
    await call(svc.baseUrl, "/query", { ...pair, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT)" });
    await call(svc.baseUrl, "/query", { ...pair, sql: "INSERT INTO items (v) VALUES ('kept')" });
  }
});

after(async () => {
  frozen.clear();
  await svc.close();
});

/** Raw fetch: the helper drops headers, and Retry-After is the point. */
async function post(path: string, body: unknown): Promise<{ status: number; retryAfter: string | null; body: any }> {
  const res = await fetch(`${svc.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() };
}

function assertMigrating(res: { status: number; retryAfter: string | null; body: any }): void {
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "ORG_MIGRATING");
  assert.equal(res.body.error.message, ORG_MIGRATING_MESSAGE);
  assert.equal(res.retryAfter, "120");
}

test("frozen: an INSERT is refused with 503 ORG_MIGRATING and Retry-After", async () => {
  frozen.add("org-a");
  assertMigrating(await post("/query", { ...A1, sql: "INSERT INTO items (v) VALUES ('late')" }));
});

test("frozen: DELETE, DROP and VACUUM are writes too", async () => {
  for (const sql of ["DELETE FROM items", "DROP TABLE items", "VACUUM"]) {
    assertMigrating(await post("/query", { ...A1, sql }));
  }
});

test("frozen: batch-execute is refused", async () => {
  assertMigrating(
    await post("/batch-execute", {
      ...A1,
      sql: "INSERT INTO items (v) VALUES (:v)",
      parameterSets: [[{ name: "v", value: { stringValue: "x" } }]],
    }),
  );
});

test("frozen: reads keep working, and nothing was written", async () => {
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) AS n FROM items" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records[0][0].longValue, 1);
});

test("frozen: another org writes as usual", async () => {
  const res = await call(svc.baseUrl, "/query", { ...B1, sql: "INSERT INTO items (v) VALUES ('fine')" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("a transaction that wrote BEFORE the freeze cannot COMMIT after it; rollback passes", async () => {
  frozen.clear();
  const { body: tx } = await call(svc.baseUrl, "/tx/begin", A1);
  const w = await call(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO items (v) VALUES ('in-tx')", transactionId: tx.transactionId });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  frozen.add("org-a");
  assertMigrating(await post("/tx/commit", { ...A1, transactionId: tx.transactionId }));
  const rb = await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId: tx.transactionId });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
});

test("a read-only transaction still commits while frozen", async () => {
  const { body: tx } = await call(svc.baseUrl, "/tx/begin", A1);
  const r = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT v FROM items", transactionId: tx.transactionId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId: tx.transactionId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
});

test("unfrozen: writes pass again", async () => {
  frozen.delete("org-a");
  const res = await post("/query", { ...A1, sql: "INSERT INTO items (v) VALUES ('after')" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.retryAfter, null);
});
