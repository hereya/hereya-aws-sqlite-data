import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { call, startTestService } from "../../helpers.ts";

const A1 = { org_id: "org-a", app_id: "app-1" };

// The worker's busy timeout is a constant in sql-worker.ts (5 s) with no
// configuration hook, so this ONE test pays it for real. It is a LOWER bound:
// SQLite adds up the sleeps it asked for, not the time they took, so a machine
// whose timers overshoot waits longer (12 s seen on a loaded laptop).
const BUSY_MS = 5000;
const SLACK_MS = 500;

/** Fires a request and records how long it took to be answered. */
function timed(baseUrl: string, path: string, body: unknown, startedAt: number) {
  return call(baseUrl, path, body).then((res) => ({ ...res, ms: Date.now() - startedAt }));
}

// One worker process per app, strictly serial, two connections: `txConn` keeps
// the write lock between the HTTP calls of an explicit transaction while the
// worker itself is idle. An autocommit write dequeued in that gap runs on the
// other connection, sleeps in SQLite's busy handler INSIDE the worker — which
// therefore cannot run the transaction's next statement or its COMMIT — and
// fails when the busy timeout runs out. Everything queued behind it waits too.
test("TODAY: an autocommit write during an open transaction stalls the app for the busy timeout, then fails", async () => {
  const svc = await startTestService({ sqlTimeoutMs: 60_000, txOpTimeoutMs: 60_000 });
  try {
    await call(svc.baseUrl, "/query", { ...A1, sql: "CREATE TABLE t (who TEXT)" });
    const begin = await call(svc.baseUrl, "/tx/begin", A1);
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    const transactionId = begin.body.transactionId;
    const first = await call(svc.baseUrl, "/query", { ...A1, transactionId, sql: "INSERT INTO t VALUES ('tx-1')" });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // Control: the open transaction alone does not delay a read (WAL).
    const aloneAt = Date.now();
    const alone = await timed(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) FROM t" }, aloneAt);
    assert.equal(alone.status, 200);
    assert.equal(alone.body.records[0][0].longValue, 0, "the uncommitted row is not visible outside the transaction");
    assert.ok(alone.ms < 1000, `a read alone took ${alone.ms}ms`);

    const t0 = Date.now();
    const write = timed(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO t VALUES ('autocommit')" }, t0);
    await sleep(100); // the write is in the worker before anything else is queued
    const read1 = timed(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) FROM t" }, t0);
    const read2 = timed(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" }, t0);
    await sleep(50);
    const batch = timed(
      svc.baseUrl,
      "/batch-execute",
      { ...A1, transactionId, sql: "INSERT INTO t VALUES (:w)", parameterSets: [[{ name: "w", value: { stringValue: "tx-2" } }]] },
      t0,
    );

    const w = await write;
    assert.equal(w.status, 400, JSON.stringify(w.body));
    assert.equal(w.body.error.code, "SQL_ERROR");
    assert.match(w.body.error.message, /database is locked/);
    assert.ok(w.ms >= BUSY_MS - SLACK_MS, `the write failed after ${w.ms}ms`);

    // The reads were never blocked by SQLite — only by the queue behind the write.
    for (const r of [await read1, await read2]) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.ms >= w.ms - SLACK_MS, `a read queued behind the write was answered after ${r.ms}ms, the write after ${w.ms}ms`);
    }
    // …and so was the transaction's own next statement.
    const b = await batch;
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.ok(b.ms >= w.ms - SLACK_MS, `the transaction's batch was answered after ${b.ms}ms, the write after ${w.ms}ms`);

    const commit = await timed(svc.baseUrl, "/tx/commit", { ...A1, transactionId }, t0);
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    console.log(JSON.stringify({ measured: "stall", writeMs: w.ms, writeError: w.body.error.message, read1Ms: (await read1).ms, read2Ms: (await read2).ms, batchMs: b.ms, commitMs: commit.ms }));

    const rows = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT who FROM t ORDER BY rowid" });
    assert.deepEqual(rows.body.records.map((r: any) => r[0].stringValue), ["tx-1", "tx-2"], "the autocommit write is lost");
  } finally {
    await svc.close();
  }
});
