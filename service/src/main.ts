// Boot orchestrator. In this milestone (service core, local mode) the strict
// restore-then-serve sequence is registry → workers → HTTP; the litestream
// restore/replicate steps slot in between once the AWS wiring lands.
import { loadConfig } from "./config.ts";
import { AppManager } from "./apps.ts";
import { Limiter } from "./limits.ts";
import { FileRegistry, type Registry } from "./registry.ts";
import { buildServer } from "./server.ts";
import { TxRegistry } from "./tx.ts";
import { resolveWorkerPath, WorkerPool } from "./worker-host.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();

  let registry: Registry;
  if (cfg.registryMode === "file") {
    registry = new FileRegistry(cfg.registryFile);
  } else {
    throw new Error("REGISTRY_MODE=ddb is not wired yet; run with REGISTRY_MODE=file for now");
  }

  const txRegistry = new TxRegistry({ idleMs: cfg.txIdleMs, maxMs: cfg.txMaxMs });
  const pool = new WorkerPool({
    maxLiveWorkers: cfg.maxLiveWorkers,
    workerPath: resolveWorkerPath(),
    callbacks: {
      onTxInvalidated: (appKey) => {
        txRegistry.deleteByAppKey(appKey);
      },
    },
    canEvict: (appKey) => !txRegistry.hasOpenTx(appKey),
  });
  const manager = new AppManager(cfg, pool);
  const limiter = new Limiter({ maxPerApp: cfg.maxInflightPerApp, maxTotal: cfg.maxInflightTotal });

  // Roll back transactions that idled out (their worker is still healthy —
  // worker death already cleans up via onTxInvalidated).
  const sweeper = setInterval(() => {
    for (const expired of txRegistry.sweep()) {
      const [orgId, appId] = expired.appKey.split("/") as [string, string];
      const worker = manager.workerFor(orgId, appId);
      void worker.control("rollback", cfg.txOpTimeoutMs).catch(() => {});
      console.log(JSON.stringify({ type: "tx-expired", appKey: expired.appKey, txId: expired.txId }));
    }
  }, 2000);
  sweeper.unref();

  // Fail-closed boot check: the registry must be readable before we serve.
  const active = await registry.listActive();
  console.log(JSON.stringify({ type: "boot", registryMode: cfg.registryMode, activeApps: active.length }));

  const server = buildServer({ cfg, registry, manager, txRegistry, limiter });
  server.listen(cfg.port, () => {
    console.log(JSON.stringify({ type: "ready", port: cfg.port }));
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ type: "shutdown", signal }));
    clearInterval(sweeper);
    server.close();
    await manager.closeAll();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({ type: "error", message: `unhandled rejection: ${String(reason)}` }));
  });
}

await main();
