import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveWorkerPath, WorkerPool, type WorkerPoolOptions } from "../../src/worker-host.ts";

const REQ = { sql: "SELECT 1 AS one", binds: {}, useTx: false, mode: "single", includeMetadata: false, maxResponseBytes: 1_048_576 } as const;

function fixture(opts: Partial<WorkerPoolOptions>) {
  const dir = mkdtempSync(join(tmpdir(), "pool-busy-"));
  const pool = new WorkerPool({
    maxLiveWorkers: 2,
    workerPath: resolveWorkerPath(),
    callbacks: { onTxInvalidated: () => {} },
    canEvict: () => true,
    ...opts,
  });
  const select = (i: number) => {
    const path = join(dir, `app-${i}`, "app.db");
    mkdirSync(dirname(path), { recursive: true });
    return pool.run(`org/app-${i}`, path, (w) => w.exec({ ...REQ }, 10_000));
  };
  const close = async () => {
    await pool.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { pool, select, close };
}

// t_worker_evict_inflight_503 — more apps touched AT ONCE than the pool has
// live workers. Found on the phase-5 trial stack: 100 parallel reads on 100
// apps → ~9 × 503 "app is shutting down". The newcomer was the only idle
// worker in the map, so the pool evicted the worker it had just created.
test("more apps at once than live workers: all answered, and never more workers than the cap", async () => {
  const f = fixture({});
  try {
    let peak = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => f.select(i).finally(() => (peak = Math.max(peak, f.pool.size)))),
    );
    const failed = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message));
    assert.deepEqual(failed, []);
    assert.ok(peak <= 2, `pool grew to ${peak} workers`);
  } finally {
    await f.close();
  }
});

test("nobody evictable (open transactions): the newcomer is refused UNAVAILABLE after the wait, the others untouched", async () => {
  const f = fixture({ canEvict: () => false, waitForRoomMs: 150 });
  try {
    await f.select(0);
    await f.select(1);
    await assert.rejects(f.select(2), (err: { code?: string }) => err.code === "UNAVAILABLE");
    assert.equal((await f.select(0)).records?.length, 1);
  } finally {
    await f.close();
  }
});
