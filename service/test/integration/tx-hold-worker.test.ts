import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BUSY_TIMEOUT_MS } from "../../src/busy-timeout.ts";
import { ServiceError } from "../../src/errors.ts";
import { AppWorker, resolveWorkerPath, type ExecRequest } from "../../src/worker-host.ts";

// The real child process and the real queue, without HTTP: what happens to the
// writes held behind an open transaction in each way that transaction can end.

const T = 30_000;
const req = (sql: string, useTx = false): ExecRequest => ({ sql, binds: {}, useTx, mode: "single", includeMetadata: false, maxResponseBytes: 1_048_576 });

interface Rig {
  worker: AppWorker;
  invalidated: string[];
  held: () => number;
  rows: () => Promise<string[]>;
}

async function rig(appKey = "org/app"): Promise<Rig> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tx-hold-")), "app.db");
  const invalidated: string[] = [];
  const worker = new AppWorker(appKey, dbPath, resolveWorkerPath(), { onTxInvalidated: (key) => invalidated.push(key) });
  await worker.exec(req("CREATE TABLE t (who TEXT)"), T);
  return {
    worker,
    invalidated,
    held: () => (worker as unknown as { txHold: { size: number } }).txHold.size,
    rows: async () => {
      const res = await worker.exec(req("SELECT who FROM t ORDER BY rowid"), T);
      return (res.records ?? []).map((r) => (r[0] as { stringValue: string }).stringValue);
    },
  };
}

const insert = (who: string, useTx = false) => req(`INSERT INTO t VALUES ('${who}')`, useTx);

/** Resolves to the order in which the given promises settled. */
function settleOrder(named: Record<string, Promise<unknown>>): { order: string[]; all: Promise<unknown> } {
  const order: string[] = [];
  const all = Promise.allSettled(Object.entries(named).map(([name, p]) => p.then(() => order.push(name), () => order.push(`${name}!`))));
  return { order, all };
}

test("held writes keep their arrival order; reads and the transaction overtake them", async () => {
  const { worker, rows, held } = await rig();
  try {
    await worker.control("begin", T);
    const jobs = {
      w1: worker.exec(insert("w1"), T),
      w2: worker.exec(insert("w2"), T),
      r1: worker.exec(req("SELECT 1"), T),
      w3: worker.exec(req("WITH c(who) AS (SELECT 'w3') INSERT INTO t SELECT who FROM c"), T),
      r2: worker.exec(req("SELECT COUNT(*) FROM t"), T),
      tx: worker.exec(insert("tx", true), T),
    };
    const { order, all } = settleOrder(jobs);
    await jobs.tx;
    assert.deepEqual(order, ["r1", "r2", "tx"], "everything that needs no lock ran, in order, while the writes waited");
    assert.equal(held(), 3);
    const late = worker.exec(req("SELECT 2"), T); // arrives AFTER the held writes, runs after them once released
    await worker.control("commit", T);
    await all;
    await late;
    assert.deepEqual(order, ["r1", "r2", "tx", "w1", "w2", "w3"]);
    assert.deepEqual(await rows(), ["tx", "w1", "w2", "w3"]);
    assert.equal(held(), 0);
  } finally {
    await worker.close();
  }
});

test("rollback releases the held writes too", async () => {
  const { worker, rows } = await rig();
  try {
    await worker.control("begin", T);
    await worker.exec(insert("tx", true), T);
    const write = worker.exec(insert("auto"), T);
    await worker.control("rollback", T);
    await write;
    assert.deepEqual(await rows(), ["auto"]);
  } finally {
    await worker.close();
  }
});

test("a held write whose own deadline is shorter than the busy timeout is answered QUERY_TIMEOUT and never runs — the worker is NOT killed", async () => {
  const { worker, rows, invalidated, held } = await rig();
  try {
    await worker.control("begin", T);
    await worker.exec(insert("tx-1", true), T);
    const startedAt = Date.now();
    await assert.rejects(worker.exec(insert("too-late"), 300), (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.code, "QUERY_TIMEOUT");
      assert.equal(err.status, 408);
      assert.equal(err.message, "query exceeded the 300ms time limit and was aborted");
      return true;
    });
    assert.ok(Date.now() - startedAt >= 290);
    assert.equal(held(), 0);
    // The transaction is intact: a deadline on a RUNNING job kills the child, this one did not.
    await worker.exec(insert("tx-2", true), T);
    await worker.control("commit", T);
    assert.deepEqual(invalidated, []);
    await sleep(50);
    assert.deepEqual(await rows(), ["tx-1", "tx-2"]);
  } finally {
    await worker.close();
  }
});

test("the worker killed on a deadline: its transaction is gone, the held writes run on the fresh one", async () => {
  const { worker, rows, invalidated } = await rig();
  try {
    await worker.control("begin", T);
    await worker.exec(insert("tx", true), T);
    const write = worker.exec(insert("auto"), T);
    const runaway = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT MAX(x) FROM c";
    await assert.rejects(worker.exec(req(runaway, true), 300), (err: unknown) => err instanceof ServiceError && err.code === "QUERY_TIMEOUT");
    await write;
    assert.deepEqual(invalidated, ["org/app"]);
    assert.deepEqual(await rows(), ["auto"], "the transaction's row died with the worker");
  } finally {
    await worker.close();
  }
});

test("the worker dying while idle inside a transaction releases the held writes", async () => {
  const { worker, rows, invalidated, held } = await rig();
  try {
    await worker.control("begin", T);
    await worker.exec(insert("tx", true), T);
    const write = worker.exec(insert("auto"), T);
    await sleep(20);
    assert.equal(held(), 1);
    (worker as unknown as { child: { kill: (signal: string) => void } }).child.kill("SIGKILL");
    await write;
    assert.deepEqual(invalidated, ["org/app"]);
    assert.equal(held(), 0);
    assert.deepEqual(await rows(), ["auto"]);
  } finally {
    await worker.close();
  }
});

test("closing the worker (app removed, moved, evicted, shutdown) fails the held writes like any queued job", async () => {
  const { worker, held } = await rig();
  await worker.control("begin", T);
  const writes = [worker.exec(insert("a"), T), worker.exec(insert("b"), T)];
  await sleep(20);
  assert.equal(held(), 2);
  assert.equal(worker.busy, true, "a worker with held writes is busy: the pool does not evict it");
  const closing = worker.close();
  for (const write of writes) {
    await assert.rejects(write, (err: unknown) => err instanceof ServiceError && err.code === "UNAVAILABLE" && err.message === "app is shutting down");
  }
  await closing;
  assert.equal(held(), 0);
});

test("a COMMIT that fails leaves the lock held: the writes stay held until the transaction really ends", async () => {
  const { worker, rows, held } = await rig();
  try {
    await worker.exec(req("CREATE TABLE parent (id INTEGER PRIMARY KEY)"), T);
    await worker.exec(req("CREATE TABLE child (p INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)"), T);
    await worker.control("begin", T);
    await worker.exec(req("INSERT INTO child VALUES (42)", true), T);
    const write = worker.exec(insert("auto"), T);
    await assert.rejects(worker.control("commit", T), /FOREIGN KEY/);
    await sleep(50);
    assert.equal(held(), 1, "released on a failed COMMIT, the write would have met the lock");
    await worker.control("rollback", T);
    await write;
    assert.deepEqual(await rows(), ["auto"]);
  } finally {
    await worker.close();
  }
});

test("the worker's busy timeout IS the constant the hold is bounded by", async () => {
  const { worker } = await rig();
  try {
    for (const useTx of [false, true]) {
      const res = await worker.exec(req("PRAGMA busy_timeout", useTx), T);
      assert.equal(Number((res.records![0]![0] as { longValue: number }).longValue), BUSY_TIMEOUT_MS);
    }
  } finally {
    await worker.close();
  }
});

test("a transaction on ANOTHER app holds nothing here", async () => {
  const [a, b] = [await rig("org/a"), await rig("org/b")];
  try {
    await a.worker.control("begin", T);
    await a.worker.exec(insert("tx", true), T);
    const startedAt = Date.now();
    await b.worker.exec(insert("other-app"), T);
    assert.ok(Date.now() - startedAt < 2000);
    assert.equal(b.held(), 0);
    await a.worker.control("commit", T);
  } finally {
    await Promise.all([a.worker.close(), b.worker.close()]);
  }
});
