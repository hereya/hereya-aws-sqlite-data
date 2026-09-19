// The drain must not cost a per-app term (t_handover_catchup_parallel).
//
// Measured on a trial stack seeded with 100 apps, 2026-09-19: the drain asked
// every served app for `PRAGMA wal_checkpoint(TRUNCATE)`, ONE AFTER ANOTHER.
// TRUNCATE needs every reader gone, and litestream holds a read transaction on
// each database it replicates — so every one of them blocked for the full
// 5000 ms, failed, and had its child killed. 100 apps = 500 s of drain, which
// systemd cut short with SIGKILL at its 90 s stop timeout: litestream never
// got its final sync window, `Litestream.stop()` never ran, write stats were
// never flushed and NO HANDOVER REPORT was ever published. That is the 132 s
// the replacement spent waiting for the ASG on the 2026-09-19 prod roll.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Shutdown } from "../service/src/shutdown.ts";
import type { Config } from "../service/src/config.ts";

test("draining 100 served apps asks none of them for a checkpoint, and reaches litestream.stop()", async () => {
  const controls: string[] = [];
  const steps: string[] = [];
  const apps = Array.from({ length: 100 }, (_, i) => ({ orgId: "org", appId: `app-${i}`, dbPath: `/x/${i}` }));
  const shutdown = new Shutdown({
    cfg: { drainMs: 0, litestreamSyncIntervalMs: 0, txOpTimeoutMs: 5000 } as Config,
    server: { close: () => steps.push("server.close") } as never,
    manager: {
      workerFor: () => ({
        control: async (action: string) => {
          controls.push(action);
          await new Promise((r) => setTimeout(r, 50));
        },
      }),
      closeAll: async () => void steps.push("closeAll"),
    } as never,
    sync: { servedApps: apps } as never,
    litestream: { stop: async () => void steps.push("litestream.stop") } as never,
    txRegistry: { hasOpenTx: () => false, deleteByAppKey: () => {} } as never,
  });

  const realExit = process.exit;
  let exited = false;
  process.exit = (() => void (exited = true)) as never;
  const startedAt = Date.now();
  try {
    await shutdown.begin("test");
  } finally {
    process.exit = realExit;
  }
  assert.deepEqual(controls, [], "no per-app control op may run during the drain: each is a 5 s block at scale");
  assert.deepEqual(steps, ["litestream.stop", "closeAll", "server.close"]);
  assert.equal(exited, true);
  assert.ok(Date.now() - startedAt < 1000, "the drain must not grow with the number of served apps");
});
