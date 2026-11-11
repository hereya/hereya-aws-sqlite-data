import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isAutocommitWrite, TxHold, type HoldableJob } from "../../src/worker-host/tx-hold.ts";

const exec = (sql: string, useTx = false) => ({ action: "exec", sql, useTx });

test("what is held: every autocommit statement that is not recognised as a read", () => {
  const writes = [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x = 1",
    "DELETE FROM t",
    "REPLACE INTO t VALUES (1)",
    "CREATE TABLE u (x)",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN y",
    "WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c",
    "WITH c AS (SELECT 1) DELETE FROM t WHERE x IN (SELECT * FROM c)",
    "VACUUM",
    "ANALYZE",
    "REINDEX",
    "ATTACH 'other.db' AS o",
    "BEGIN",
    "SELECT 1; INSERT INTO t VALUES (1)",
    "/* SELECT */ INSERT INTO t VALUES (1)",
    "SAVEPOINT s",
    "not sql at all",
  ];
  for (const sql of writes) assert.equal(isAutocommitWrite(exec(sql)), true, sql);
});

test("what keeps flowing: reads, the transaction's own statements, and control jobs", () => {
  const reads = [
    "SELECT * FROM t",
    "  (SELECT 1)",
    "WITH c AS (SELECT 1) SELECT * FROM c",
    "EXPLAIN INSERT INTO t VALUES (1)",
    "PRAGMA table_info(t)",
    "SELECT 'INSERT INTO t'",
    // No lock on an existing object, and it has always passed during a
    // transaction; when it must create the object it meets the lock as before.
    "CREATE TABLE IF NOT EXISTS t (x)",
  ];
  for (const sql of reads) assert.equal(isAutocommitWrite(exec(sql)), false, sql);
  assert.equal(isAutocommitWrite(exec("INSERT INTO t VALUES (1)", true)), false, "a statement of the transaction");
  for (const action of ["begin", "commit", "rollback", "checkpoint"]) assert.equal(isAutocommitWrite({ action }), false, action);
});

function job(msg: Record<string, unknown>, timeoutMs = 10_000): HoldableJob {
  return { msg, timeoutMs };
}

function captureLog<T>(fn: (lines: Array<Record<string, unknown>>) => T): T {
  const lines: Array<Record<string, unknown>> = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(JSON.parse(line));
  try {
    return fn(lines);
  } finally {
    console.log = original;
  }
}

test("no transaction open: a job is not even looked at", () => {
  const hold = new TxHold<HoldableJob>("org/app", () => assert.fail("nothing can time out"));
  const untouchable = new Proxy({}, { get: () => assert.fail("the job was inspected") });
  assert.equal(hold.holds(job(untouchable)), false);
  assert.equal(hold.size, 0);
});

test("a transaction ending releases what was held, with ONE line that carries no SQL", () => {
  captureLog((lines) => {
    const hold = new TxHold<HoldableJob>("org/app", () => assert.fail("nothing timed out"));
    hold.set(true);
    const w1 = job(exec("INSERT INTO secrets VALUES ('hunter2')"));
    const w2 = job(exec("DELETE FROM secrets"));
    assert.equal(hold.holds(w1), true);
    assert.equal(hold.holds(w1), true, "asked again at the next pump: still held, counted once");
    assert.equal(hold.holds(job(exec("SELECT 1"))), false);
    assert.equal(hold.holds(w2), true);
    assert.equal(hold.size, 2);

    hold.set(false);
    assert.equal(hold.size, 0);
    assert.equal(hold.holds(w1), false);
    assert.equal(lines.length, 1);
    const line = lines[0]!;
    assert.deepEqual(
      { type: line.type, appKey: line.appKey, event: line.event, held: line.held },
      { type: "tx-hold", appKey: "org/app", event: "tx-ended", held: 2 },
    );
    assert.equal(typeof line.waitedMs, "number");
    assert.deepEqual(Object.keys(line).sort(), ["appKey", "event", "held", "ts", "type", "waitedMs"]);

    hold.set(true);
    hold.set(false);
    assert.equal(lines.length, 1, "a transaction that held nothing logs nothing");
  });
});

test("a held job that runs out of time is handed back once, and its timer dies with the hold", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(JSON.parse(line));
  try {
    const timedOut: HoldableJob[] = [];
    const hold = new TxHold<HoldableJob>("org/app", (j) => timedOut.push(j));
    hold.set(true);
    const slow = job(exec("INSERT INTO t VALUES (1)"), 30);
    const released = job(exec("INSERT INTO t VALUES (2)"), 200);
    hold.holds(slow);
    hold.holds(released);
    await sleep(100);
    assert.deepEqual(timedOut, [slow]);
    assert.equal(hold.size, 1);
    hold.set(false, "worker-gone");
    await sleep(250);
    assert.equal(timedOut.length, 1, "the released job's timer was cleared");
    assert.deepEqual(lines.map((l) => [l.event, l.held]), [["timeout", 1], ["worker-gone", 1]]);
  } finally {
    console.log = original;
  }
});
