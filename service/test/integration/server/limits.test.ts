import assert from "node:assert/strict";
import { test } from "node:test";
import { call, startTestService } from "../../helpers.ts";

const A1 = { org_id: "org-a", app_id: "app-1" };

test("oversized results are rejected with RESULT_TOO_LARGE", async () => {
  const small = await startTestService({ maxResponseBytes: 1000 });
  try {
    await call(small.baseUrl, "/query", { ...A1, sql: "CREATE TABLE big (s TEXT)" });
    await call(small.baseUrl, "/query", {
      ...A1,
      sql: "INSERT INTO big VALUES (:s)",
      params: [{ name: "s", value: { stringValue: "z".repeat(5000) } }],
    });
    const res = await call(small.baseUrl, "/query", { ...A1, sql: "SELECT s FROM big" });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "RESULT_TOO_LARGE");
  } finally {
    await small.close();
  }
});

test("per-app in-flight cap returns 429", async () => {
  const capped = await startTestService({ maxInflightPerApp: 1, sqlTimeoutMs: 2000 });
  try {
    const bomb = call(capped.baseUrl, "/query", {
      ...A1,
      sql: "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT MAX(x) FROM r",
    });
    await new Promise((r) => setTimeout(r, 200)); // let the bomb occupy the slot
    const throttled = await call(capped.baseUrl, "/query", { ...A1, sql: "SELECT 1" });
    assert.equal(throttled.status, 429, JSON.stringify(throttled.body));
    assert.equal(throttled.body.error.code, "THROTTLED");
    const bombRes = await bomb;
    assert.equal(bombRes.status, 408);
  } finally {
    await capped.close();
  }
});
