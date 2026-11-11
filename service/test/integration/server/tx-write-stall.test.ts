import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startTxSweeper } from "../../../src/boot/loops.ts";
import { call, startTestService, type TestService } from "../../helpers.ts";

const A1 = { org_id: "org-a", app_id: "app-1" };
const A2 = { org_id: "org-a", app_id: "app-2" };

// What the same write used to cost: the worker's busy timeout (a constant in
// sql-worker.ts), spent inside the worker with everything else queued behind.
const BUSY_MS = 5000;
/** Generous on purpose: "at once" must hold on a loaded machine and still be far from BUSY_MS. */
const SOON_MS = 2000;

/** Fires a request and records how long it took to be answered. */
function timed(baseUrl: string, path: string, body: unknown, startedAt = Date.now()) {
  return call(baseUrl, path, body).then((res) => ({ ...res, ms: Date.now() - startedAt }));
}

async function openTx(svc: TestService): Promise<string> {
  await call(svc.baseUrl, "/query", { ...A1, sql: "CREATE TABLE t (who TEXT)" });
  const begin = await call(svc.baseUrl, "/tx/begin", A1);
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const transactionId = begin.body.transactionId;
  const first = await call(svc.baseUrl, "/query", { ...A1, transactionId, sql: "INSERT INTO t VALUES ('tx-1')" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  return transactionId;
}

async function who(svc: TestService): Promise<string[]> {
  const rows = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT who FROM t ORDER BY rowid" });
  return rows.body.records.map((r: any) => r[0].stringValue);
}

// One worker process per app, strictly serial, two connections: `txConn` keeps
// the write lock between the HTTP calls of an explicit transaction while the
// worker itself is idle. An autocommit write handed to the worker in that gap
// slept in SQLite's busy handler INSIDE the worker — which could then run
// neither the transaction's next statement nor its COMMIT — and failed
// "database is locked" once the busy timeout ran out, everything else queued
// behind it. Same scenario as before the fix; the write now waits in the queue.
test("an autocommit write during an open transaction waits for it to end, then succeeds — nothing else waits", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const original = console.log;
  console.log = (line: string) => void (line.includes('"tx-hold"') ? lines.push(JSON.parse(line)) : original(line));
  const svc = await startTestService({ sqlTimeoutMs: 60_000, txOpTimeoutMs: 60_000 });
  try {
    const transactionId = await openTx(svc);

    const t0 = Date.now();
    let writeDone = false;
    const write = timed(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO t VALUES ('autocommit')" }, t0).finally(() => (writeDone = true));
    await sleep(100); // the write is queued before anything else
    const [read1, read2] = await Promise.all([
      timed(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) FROM t" }),
      timed(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" }),
    ]);
    for (const r of [read1, read2]) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.ms < SOON_MS, `a read behind the held write took ${r.ms}ms`);
    }
    assert.equal(read1.body.records[0][0].longValue, 0, "neither the transaction's row nor the held write is visible yet");
    const batch = await timed(svc.baseUrl, "/batch-execute", {
      ...A1,
      transactionId,
      sql: "INSERT INTO t VALUES (:w)",
      parameterSets: [[{ name: "w", value: { stringValue: "tx-2" } }]],
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.ok(batch.ms < SOON_MS, `the transaction's batch took ${batch.ms}ms`);
    assert.equal(writeDone, false, "the write is still waiting for the transaction");

    const commit = await timed(svc.baseUrl, "/tx/commit", { ...A1, transactionId });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    const committedAt = Date.now();
    const w = await write;
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.numberOfRecordsUpdated, 1);
    assert.ok(Date.now() - committedAt < SOON_MS, "the write did not run right after the commit");
    const totalMs = Date.now() - t0;
    assert.ok(totalMs < BUSY_MS - 1000, `the whole exchange took ${totalMs}ms`);
    original(JSON.stringify({ measured: "hold", writeMs: w.ms, read1Ms: read1.ms, read2Ms: read2.ms, batchMs: batch.ms, commitMs: commit.ms, totalMs }));

    assert.deepEqual(await who(svc), ["tx-1", "tx-2", "autocommit"]);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual([lines[0]!.appKey, lines[0]!.event, lines[0]!.held], ["org-a/app-1", "tx-ended", 1]);
    assert.ok((lines[0]!.waitedMs as number) >= 100);
    assert.doesNotMatch(JSON.stringify(lines), /INSERT|autocommit/, "no SQL in the line");
  } finally {
    console.log = original;
    await svc.close();
  }
});

test("rollback releases a held write; a batch-execute without transactionId is held as a whole", async () => {
  const svc = await startTestService();
  try {
    const transactionId = await openTx(svc);
    const batch = call(svc.baseUrl, "/batch-execute", {
      ...A1,
      sql: "INSERT INTO t VALUES (:w)",
      parameterSets: ["b1", "b2", "b3"].map((w) => [{ name: "w", value: { stringValue: w } }]),
    });
    await sleep(100);
    assert.deepEqual(await who(svc), [], "nothing of the batch ran while the transaction was open");
    const rollback = await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId });
    assert.equal(rollback.status, 200);
    const b = await batch;
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual(b.body.updateResults, [1, 1, 1].map((n) => ({ numberOfRecordsUpdated: n })));
    assert.deepEqual(await who(svc), ["b1", "b2", "b3"]);
  } finally {
    await svc.close();
  }
});

test("writes that look like reads are held; CREATE … IF NOT EXISTS on an existing table still passes at once", async () => {
  const svc = await startTestService();
  try {
    const transactionId = await openTx(svc);
    const held = [
      call(svc.baseUrl, "/query", { ...A1, sql: "WITH c(who) AS (SELECT 'cte') INSERT INTO t SELECT who FROM c" }),
      call(svc.baseUrl, "/query", { ...A1, sql: "VACUUM" }),
    ];
    const idempotent = await timed(svc.baseUrl, "/query", { ...A1, sql: "CREATE TABLE IF NOT EXISTS t (who TEXT)" });
    assert.equal(idempotent.status, 200, JSON.stringify(idempotent.body));
    assert.ok(idempotent.ms < SOON_MS, `took ${idempotent.ms}ms`);
    assert.equal((await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId })).status, 200);
    for (const res of await Promise.all(held)) assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await who(svc), ["tx-1", "cte"]);
  } finally {
    await svc.close();
  }
});

test("a second /tx/begin while one is open is refused as before, held write or not; another app is not held", async () => {
  const svc = await startTestService();
  try {
    const transactionId = await openTx(svc);
    const write = call(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO t VALUES ('autocommit')" });
    await sleep(50);
    const second = await call(svc.baseUrl, "/tx/begin", A1);
    assert.equal(second.status, 400);
    assert.deepEqual(second.body.error, { code: "BAD_REQUEST", message: "this app already has an open transaction (one at a time)" });

    await call(svc.baseUrl, "/query", { ...A2, sql: "CREATE TABLE t (who TEXT)" });
    const other = await timed(svc.baseUrl, "/query", { ...A2, sql: "INSERT INTO t VALUES ('other app')" });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.ok(other.ms < SOON_MS, `another app's write took ${other.ms}ms`);

    assert.equal((await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId })).status, 200);
    assert.equal((await write).status, 200);
    assert.equal((await call(svc.baseUrl, "/tx/begin", A1)).status, 200, "and a new transaction can begin afterwards");
  } finally {
    await svc.close();
  }
});

// The sweeper is the service's own (boot/loops.ts, a 2 s tick): a transaction
// that expires is rolled back by it, and that is what releases the write.
for (const [limit, overrides] of [
  ["idle", { txIdleMs: 300 }],
  ["max", { txMaxMs: 300 }],
] as const) {
  test(`a transaction aborted by its ${limit} limit releases the held write`, async () => {
    const svc = await startTestService({ sqlTimeoutMs: 60_000, ...overrides });
    const sweeper = startTxSweeper(svc.parts.cfg, svc.parts.txRegistry, svc.parts.manager);
    try {
      const transactionId = await openTx(svc);
      const write = timed(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO t VALUES ('autocommit')" });
      await sleep(400);
      // Touched after it expired and BEFORE the sweep: this used to make the
      // registry forget a transaction the worker was still inside, for good.
      const late = await call(svc.baseUrl, "/query", { ...A1, transactionId, sql: "INSERT INTO t VALUES ('tx-2')" });
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, "TX_EXPIRED");
      const w = await write;
      assert.equal(w.status, 200, JSON.stringify(w.body));
      assert.ok(w.ms >= 300 && w.ms < BUSY_MS - 1000, `released after ${w.ms}ms`);
      assert.deepEqual(await who(svc), ["autocommit"]);
      const again = await call(svc.baseUrl, "/tx/begin", A1);
      assert.equal(again.status, 200, JSON.stringify(again.body));
    } finally {
      clearInterval(sweeper);
      await svc.close();
    }
  });
}

test("a held write that runs out of its own time is answered 408 QUERY_TIMEOUT and never runs", async () => {
  const svc = await startTestService({ sqlTimeoutMs: 400 });
  try {
    const transactionId = await openTx(svc);
    const w = await timed(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO t VALUES ('too late')" });
    assert.equal(w.status, 408, JSON.stringify(w.body));
    assert.deepEqual(w.body.error, {
      code: "QUERY_TIMEOUT",
      message: "query waited 400ms for this app's open transaction to end and was not run",
    });
    assert.ok(w.ms >= 390, `answered after ${w.ms}ms`);
    assert.equal((await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId })).status, 200, "the transaction survived it");
    await sleep(100);
    assert.deepEqual(await who(svc), ["tx-1"]);
  } finally {
    await svc.close();
  }
});
