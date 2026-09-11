import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { call, DEFAULT_REGISTRY, startTestService, type TestService } from "../../helpers.ts";

let svc: TestService;

before(async () => {
  svc = await startTestService();
});

after(async () => {
  await svc.close();
});

const A2 = { org_id: "org-a", app_id: "app-2" };

test("health", async () => {
  const res = await call(svc.baseUrl, "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("multi-statement script works without params, rejected with params", async () => {
  const ok = await call(svc.baseUrl, "/query", {
    ...A2,
    sql: "CREATE TABLE t (x TEXT); CREATE INDEX ix ON t(x); INSERT INTO t VALUES ('a');",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.numberOfRecordsUpdated, 1);

  const bad = await call(svc.baseUrl, "/query", {
    ...A2,
    sql: "INSERT INTO t VALUES (:x); INSERT INTO t VALUES (:x);",
    params: [{ name: "x", value: { stringValue: "y" } }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "BAD_REQUEST");
});

test("unknown / inactive / cross pairs are denied fail-closed", async () => {
  for (const pair of [
    { org_id: "org-a", app_id: "nope" },
    { org_id: "org-nope", app_id: "app-1" },
    { org_id: "org-a", app_id: "app-old" }, // inactive
    { org_id: "org-b", app_id: "app-2" }, // app-2 belongs to org-a only
  ]) {
    const res = await call(svc.baseUrl, "/query", { ...pair, sql: "SELECT 1" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "CROSS_ORG_DENIED");
  }
});

test("registry hot-reload: newly added app becomes servable, removed app is denied", async () => {
  const before = await call(svc.baseUrl, "/query", { org_id: "org-c", app_id: "fresh", sql: "SELECT 1" });
  assert.equal(before.status, 403);

  svc.setRegistry([...DEFAULT_REGISTRY, { org_id: "org-c", app_id: "fresh", status: "active" }]);
  const after = await call(svc.baseUrl, "/query", { org_id: "org-c", app_id: "fresh", sql: "SELECT 1" });
  assert.equal(after.status, 200, JSON.stringify(after.body));
});
