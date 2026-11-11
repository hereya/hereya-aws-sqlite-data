import assert from "node:assert/strict";
import { test } from "node:test";
import { call, startTestService } from "../../helpers.ts";

const A1 = { org_id: "org-a", app_id: "app-1" };

// The busy timeout (sql-worker.ts). A lower bound for the wait: SQLite adds up
// the sleeps it asked for, a timer never fires early.
const BUSY_MS = 5000;

// The self-inflicted case: ONE caller opens a transaction and then awaits an
// autocommit write of its own before going on (a plain statement issued from
// inside a transaction's flow). Nobody else can end the transaction, so that
// write cannot succeed — and what the caller sees must not depend on WHERE the
// write did its waiting: in the worker's busy handler, or held in the queue.
// Same outcome on both sides of the hold rule: the write fails "database is
// locked" after the busy timeout, the transaction goes on and commits.
test("a caller awaiting an autocommit write inside its own transaction: the write fails locked, the transaction survives", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => void (lines.push(line), original(line));
  const svc = await startTestService({ sqlTimeoutMs: 60_000, txOpTimeoutMs: 60_000 });
  try {
    await call(svc.baseUrl, "/query", { ...A1, sql: "CREATE TABLE t (who TEXT)" });
    const begin = await call(svc.baseUrl, "/tx/begin", A1);
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    const transactionId = begin.body.transactionId;
    const set = (who: string) => [{ name: "w", value: { stringValue: who } }];
    const batch = await call(svc.baseUrl, "/batch-execute", { ...A1, transactionId, sql: "INSERT INTO t VALUES (:w)", parameterSets: [set("tx-1"), set("tx-2")] });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));

    const startedAt = Date.now();
    const write = await call(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO t VALUES ('autocommit')" });
    const writeMs = Date.now() - startedAt;
    assert.equal(write.status, 400, JSON.stringify(write.body));
    assert.deepEqual(write.body, { error: { code: "SQL_ERROR", message: "database is locked" } });
    assert.ok(writeMs >= BUSY_MS - 100, `the write was answered after ${writeMs}ms`);
    const audit = lines.map((l) => JSON.parse(l)).filter((l) => l.type === "audit" && l.allowed === false);
    assert.equal(audit.length, 1);
    assert.deepEqual(
      { route: audit[0].route, orgId: audit[0].orgId, appId: audit[0].appId, code: audit[0].code, detail: audit[0].detail },
      { route: "POST /query", orgId: "org-a", appId: "app-1", code: "SQL_ERROR", detail: "database is locked" },
    );

    const next = await call(svc.baseUrl, "/query", { ...A1, transactionId, sql: "INSERT INTO t VALUES ('tx-3')" });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const commit = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    original(JSON.stringify({ measured: "self-write", writeMs, status: write.status, error: write.body.error }));

    const rows = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT who FROM t ORDER BY rowid" });
    assert.deepEqual(rows.body.records.map((r: any) => r[0].stringValue), ["tx-1", "tx-2", "tx-3"]);
  } finally {
    console.log = original;
    await svc.close();
  }
});
