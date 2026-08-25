// Strict boot order (spec §4): read registry → restore EVERY active app →
// bind the HTTP API → start litestream replication → background loops → ready.
// Any restore failure aborts the boot — never serve partially restored.
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import { AppManager } from "./apps.ts";
import { CloudMapRegistration } from "./cloudmap.ts";
import { daysToMs } from "./eviction.ts";
import { Heartbeat } from "./heartbeat.ts";
import { Limiter } from "./limits.ts";
import { Litestream } from "./litestream.ts";
import { DbQuotaGuard, DdbOrgQuotaReader, StaticOrgQuotaReader, type OrgQuotaReader } from "./quota.ts";
import { DdbRegistry, FileRegistry, type Registry } from "./registry.ts";
import { buildServer } from "./server.ts";
import { Shutdown } from "./shutdown.ts";
import { AppSync } from "./sync.ts";
import { WriteStats } from "./write-stats.ts";
import { TxRegistry } from "./tx.ts";
import { assertVecLoadable } from "./vec.ts";
import { resolveWorkerPath, WorkerPool } from "./worker-host.ts";

export interface RunningService {
  server: Server;
  port: number;
  sync: AppSync;
  litestream: Litestream;
  stop: () => Promise<void>;
}

export function createRegistry(cfg: Config): Registry {
  if (cfg.registryMode === "file") return new FileRegistry(cfg.registryFile);
  return new DdbRegistry({ tableName: cfg.registryTable, region: cfg.awsRegion, cacheMs: cfg.registryCacheMs });
}

/**
 * Where org caps come from. In file (local-dev) mode there is no org row to
 * read and nothing to bill, so nothing is capped.
 */
export function createOrgQuotaReader(cfg: Config): OrgQuotaReader {
  if (cfg.registryMode === "file") return new StaticOrgQuotaReader();
  return new DdbOrgQuotaReader({
    tableName: cfg.registryTable,
    region: cfg.awsRegion,
    cacheMs: cfg.orgQuotaCacheMs,
  });
}

export async function bootService(cfg: Config, opts: { installSignalHandlers?: boolean } = {}): Promise<RunningService> {
  // 0. fail-fast: every sql-worker preloads vec0 on connection open, so prove
  // the extension loads on this runtime before restoring/serving anything.
  const vecVersion = assertVecLoadable();

  const registry = createRegistry(cfg);
  const litestream = new Litestream(cfg);
  const txRegistry = new TxRegistry({ idleMs: cfg.txIdleMs, maxMs: cfg.txMaxMs });
  const pool = new WorkerPool({
    maxLiveWorkers: cfg.maxLiveWorkers,
    workerPath: resolveWorkerPath(),
    callbacks: { onTxInvalidated: (appKey) => txRegistry.deleteByAppKey(appKey) },
    canEvict: (appKey) => !txRegistry.hasOpenTx(appKey),
  });
  const manager = new AppManager(cfg, pool);
  const limiter = new Limiter({ maxPerApp: cfg.maxInflightPerApp, maxTotal: cfg.maxInflightTotal });
  const sync = new AppSync(registry, manager, litestream, cfg.bootRestoreConcurrency);
  const quota = new DbQuotaGuard({ dbDir: cfg.dbDir, reader: createOrgQuotaReader(cfg) });
  // Per-app write recency. Seeded from DynamoDB so an instance replacement does
  // not reset the very history it exists to accumulate — that reset is exactly
  // what made the replica-bucket timestamps unusable.
  const writeStats = new WriteStats({
    tableName: cfg.registryMode === "ddb" ? cfg.registryTable : "",
    region: cfg.awsRegion,
  });
  try {
    const loaded = await writeStats.load();
    if (loaded > 0) console.log(JSON.stringify({ type: "write-stats", event: "loaded", apps: loaded }));
    // Date the observation itself. Written once, ever, then read back on every
    // later boot — it is what lets "we have never seen this app write" mature
    // from ignorance into evidence. See src/eviction.ts.
    const since = await writeStats.ensureObserving();
    console.log(
      JSON.stringify({
        type: "write-stats",
        event: "observing",
        since: since === null ? null : new Date(since).toISOString(),
        forDays: since === null ? null : Math.round((Date.now() - since) / 86_400_000),
      }),
    );
  } catch (err) {
    // Never fail a boot over a statistic.
    console.error(JSON.stringify({ type: "write-stats", event: "load-failed", message: (err as Error).message }));
  }

  // 1-3. registry + restore-then-serve (throws on any failure = boot aborts)
  const servedAtBoot = await sync.bootRestoreAll();

  // 4. bind the HTTP API
  let shutdownRef: Shutdown | null = null;
  const server = buildServer({
    cfg,
    registry,
    manager,
    txRegistry,
    limiter,
    quota,
    ensureServed: (orgId, appId) => sync.ensureServed(orgId, appId),
    recordWrite: (orgId, appId, changed) => writeStats.record(orgId, appId, changed),
    onAdminSync: () => sync.syncOnce(),
    onDeleteApp: (orgId, appId) => sync.removeApp(orgId, appId),
    health: () => ({ litestream: litestream.healthy ? "up" : "down", vec: vecVersion }),
    isDraining: () => shutdownRef?.isDraining ?? false,
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : cfg.port;

  // 5. continuous replication
  litestream.start(servedAtBoot);

  // 6. announce ourselves to the API Gateway path (Cloud Map), only once the
  // API is actually able to answer
  let cloudMap: CloudMapRegistration | null = null;
  if (cfg.cloudMapServiceId) {
    cloudMap = new CloudMapRegistration({
      serviceId: cfg.cloudMapServiceId,
      region: cfg.awsRegion,
      port,
    });
    await cloudMap.register();
  }

  // background loops
  const sweeper = setInterval(() => {
    for (const expired of txRegistry.sweep()) {
      const [orgId, appId] = expired.appKey.split("/") as [string, string];
      void manager.workerFor(orgId, appId).control("rollback", cfg.txOpTimeoutMs).catch(() => {});
      console.log(JSON.stringify({ type: "tx-expired", appKey: expired.appKey, txId: expired.txId }));
    }
  }, 2000);
  sweeper.unref();

  const poller = setInterval(() => {
    void sync.syncOnce().catch((err) => {
      console.error(JSON.stringify({ type: "sync", error: (err as Error).message }));
    });
  }, cfg.registryPollSeconds * 1000);
  poller.unref();

  writeStats.start(cfg.writeStatsFlushMs);

  // Eviction sweep: stop replicating apps that have not changed in days. Off
  // unless EVICTION_IDLE_DAYS is set — see src/eviction.ts for why the
  // threshold IS the safety argument, not just an economic one.
  const evictionThresholdMs = daysToMs(cfg.evictionIdleDays);
  let evictionSweep: NodeJS.Timeout | null = null;
  if (evictionThresholdMs > 0 && cfg.evictionSweepMs > 0) {
    const probe = {
      idleMs: (key: string) => {
        const [orgId, appId] = key.split("/") as [string, string];
        return writeStats.idleMsFor(orgId, appId);
      },
      hasOpenTx: (key: string) => txRegistry.hasOpenTx(key),
      inFlight: (key: string) => limiter.inFlight(key),
      observedForMs: () => writeStats.observedForMs(),
    };
    evictionSweep = setInterval(() => {
      void sync.evictIdle(probe, evictionThresholdMs).catch((err) => {
        // A sweep that fails changes nothing: the apps stay replicated, which
        // is the safe side of this decision.
        console.error(JSON.stringify({ type: "eviction", event: "sweep-failed", message: (err as Error).message }));
      });
    }, cfg.evictionSweepMs);
    evictionSweep.unref();
    console.log(
      JSON.stringify({
        type: "eviction",
        event: "enabled",
        idleDays: cfg.evictionIdleDays,
        sweepMs: cfg.evictionSweepMs,
        // Until this exceeds idleDays, an app the counter never saw write stays
        // protected — so this number says what the sweep is actually able to do.
        observedForDays: (() => {
          const ms = writeStats.observedForMs();
          return ms === null ? null : Math.round(ms / 86_400_000);
        })(),
      }),
    );
  }

  const heartbeat = new Heartbeat(cfg, () => litestream.healthy, undefined, {
    litestreamPid: () => litestream.childPid,
    servedApps: () => sync.servedApps.length,
    replicatedApps: () => sync.replicatedApps.length,
  });
  heartbeat.start();

  const shutdown = new Shutdown({ cfg, server, manager, sync, litestream, txRegistry, cloudMap });
  shutdownRef = shutdown;
  if (opts.installSignalHandlers !== false) shutdown.install();

  console.log(
    JSON.stringify({ type: "ready", port, apps: servedAtBoot.length, registryMode: cfg.registryMode }),
  );

  return {
    server,
    port,
    sync,
    litestream,
    stop: async () => {
      clearInterval(sweeper);
      clearInterval(poller);
      if (evictionSweep) clearInterval(evictionSweep);
      heartbeat.stop();
      // Flush before dying: a clean stop should not throw away the interval's worth
      // of history it is holding.
      writeStats.stop();
      await writeStats.flush();
      await litestream.stop();
      await manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
