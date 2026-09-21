import assert from "node:assert/strict";
import { test } from "node:test";
import { call, startTestService } from "../../helpers.ts";

const A1 = { org_id: "org-a", app_id: "app-1" };
const A2 = { org_id: "org-a", app_id: "app-2" };

// t_worker_evict_inflight_503. With ONE live worker every second app has to
// wait for the first one's lease to end — which is exactly when a BEGIN that
// the tx registry does not know yet would be evicted along with its worker.
test("an app waiting for a worker never takes the one that has just begun a transaction", async () => {
  const svc = await startTestService({ maxLiveWorkers: 1, workerWaitMs: 5000 });
  try {
    await call(svc.baseUrl, "/query", { ...A1, sql: "CREATE TABLE t (x INTEGER)" });
    for (let round = 0; round < 5; round++) {
      const beginning = call(svc.baseUrl, "/tx/begin", A1);
      // NOT awaited yet: it can only be served once the transaction is over.
      const other = call(svc.baseUrl, "/query", { ...A2, sql: "SELECT 1" });
      const begin = await beginning;
      assert.equal(begin.status, 200, JSON.stringify(begin.body));
      const transactionId = begin.body.transactionId;
      const insert = await call(svc.baseUrl, "/query", { ...A1, transactionId, sql: `INSERT INTO t VALUES (${round})` });
      assert.equal(insert.status, 200, JSON.stringify(insert.body));
      const commit = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId });
      assert.equal(commit.status, 200, JSON.stringify(commit.body));
      // …and the commit is what wakes it: not its own 5 s wait running out.
      const committedAt = Date.now();
      assert.equal((await other).status, 200);
      assert.ok(Date.now() - committedAt < 2000, "the waiting app slept through the commit");
    }
    const count = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) FROM t" });
    assert.equal(count.body.records[0][0].longValue, 5);
  } finally {
    await svc.close();
  }
});
