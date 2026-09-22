// t_quota_db_bypass: what the guard classifies as a write, and the room it
// hands the worker's page ceiling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbQuotaGuard, EXEMPT_SLACK_BYTES, MB, StaticOrgQuotaReader, sqlSkipsQuota } from "../../src/quota.ts";

test("a CTE is a read only when what follows it reads", () => {
  assert.equal(sqlSkipsQuota("WITH c AS (SELECT 1) SELECT * FROM c"), true);
  assert.equal(sqlSkipsQuota("WITH c AS (SELECT id FROM t) DELETE FROM t WHERE id IN c"), true);
  for (const verb of ["INSERT INTO t SELECT * FROM c", "UPDATE t SET a = 1", "REPLACE INTO t SELECT * FROM c"]) {
    assert.equal(sqlSkipsQuota(`WITH c AS (SELECT 1) ${verb}`), false, verb);
  }
  // A write verb inside a string literal is data, not a verb.
  assert.equal(sqlSkipsQuota("WITH c AS (SELECT 'insert') SELECT * FROM c"), true);
});

test("the idempotent CREATE … IF NOT EXISTS passes; creating data never does", () => {
  assert.equal(sqlSkipsQuota("CREATE TABLE IF NOT EXISTS _mail_log (id INTEGER)"), true);
  assert.equal(sqlSkipsQuota("create unique index if not exists i on t(a)"), true);
  assert.equal(sqlSkipsQuota("CREATE TABLE t (a)"), false);
  assert.equal(sqlSkipsQuota("CREATE TABLE IF NOT EXISTS t AS SELECT randomblob(1e9)"), false);
  assert.equal(sqlSkipsQuota("CREATE TRIGGER IF NOT EXISTS g AFTER DELETE ON a BEGIN SELECT 1; END"), false);
});

test("the guard returns the room left, a slack for exempt SQL over the cap, null uncapped", async () => {
  const guard = (used: number) =>
    new DbQuotaGuard({
      dbDir: "/nowhere",
      reader: new StaticOrgQuotaReader({ capped: 10, free: null }),
      measure: () => used,
    });
  assert.equal(await guard(4 * MB).assertWriteAllowed("free", "INSERT INTO t VALUES (1)"), null);
  assert.equal(await guard(4 * MB).assertWriteAllowed("capped", "INSERT INTO t VALUES (1)"), 6 * MB);
  assert.equal(await guard(4 * MB).assertWriteAllowed("capped", "DELETE FROM t"), 6 * MB + EXEMPT_SLACK_BYTES);
  assert.equal(await guard(12 * MB).assertWriteAllowed("capped", "DELETE FROM t"), EXEMPT_SLACK_BYTES);
  await assert.rejects(guard(12 * MB).assertWriteAllowed("capped", "INSERT INTO t VALUES (1)"), /DB_QUOTA|plan/);
});
