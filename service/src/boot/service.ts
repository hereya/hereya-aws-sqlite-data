// Strict boot order (spec §4): read registry → restore EVERY active app →
// bind the HTTP API → start litestream replication → background loops → ready.
// Any restore failure aborts the boot — never serve partially restored.
import type { Config } from "../config.ts";
import { AppManager, appKeyOf } from "../apps.ts";
import { Heartbeat } from "../heartbeat.ts";
import { Limiter } from "../limits.ts";
import { Litestream } from "../litestream.ts";
import { DbQuotaGuard } from "../quota.ts";
import { buildServer } from "../server.ts";
import { Shutdown } from "../shutdown.ts";
import { AppSync } from "../sync.ts";
import { WriteStats } from "../write-stats.ts";
import { TxRegistry } from "../tx.ts";
import { assertVecLoadable } from "../vec.ts";
import { resolveWorkerPath, WorkerPool } from "../worker-host.ts";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createCells } from "./cells.ts";
import { createHandoverClient, createOrgQuotaReader, createRegistry } from "./deps.ts";
import { logDiskVolume } from "./disk-log.ts";
import { startEvictionSweep, startRegistryPoller, startTxSweeper } from "./loops.ts";
import { BootTimer, publishBootTiming } from "./timing.ts";
import { runHandoverGate } from "../handover/gate.ts";
import { announceWarming } from "../handover/protocol.ts";
import type { HandoverRecord } from "../handover/record.ts";
import { readInstanceId } from "../handover/instance-id.ts";
import { completeLaunchHook, createLifecycleClient } from "../handover/lifecycle.ts";
import { listPeers } from "../handover/overlap.ts";
import { WarmingWatcher } from "../handover/watcher.ts";
import { markWriter, wasWriter } from "../handover/writer-marker.ts";
import type { RunningService } from "./types.ts";
import { seedWriteStats } from "./write-stats-boot.ts";

export async function bootService(cfg: Config, opts: { installSignalHandlers?: boolean } = {}): Promise<RunningService> {
  // Phase timings for t_vm_boot_slim — an instrument, never a gate.
  const bootTimer = new BootTimer();

  // 0. fail-fast: every sql-worker preloads vec0 on connection open, so prove
  // the extension loads on this runtime before restoring/serving anything.
  const vecVersion = assertVecLoadable();
  bootTimer.mark("vec");

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
  await seedWriteStats(writeStats);
  bootTimer.mark("seed-write-stats");

  // The "still in use" mark becomes durable here. Attached AFTER `load()` so
  // the store already holds the previous instance's touches: without this the
  // `recently-served` guard is blind after every deploy, and an app that is
  // read constantly but never written can be evicted at the next sweep
  // (t_3bdea3eeebb6). Attaching is all it takes — `AppSync` prefers its own
  // in-memory mark and only falls back to this one.
  sync.setTouchSink({
    recordTouch: (key, atMs) => writeStats.recordTouch(key, atMs),
    msSinceTouch: (key) => writeStats.msSinceTouch(key),
  });

  // 0-bis. ANNOUNCE THE WARM-UP — before the restore, and that order is the
  // point. The announcement opens the window whose writes the departing
  // instance will report; the restore below takes ~21.5 s on the measured
  // fleet, and a write landing inside it is exactly the one our copy misses.
  // Announcing after the restore would leave those writes outside the
  // catch-up list AND outside our copy — stale data, silently.
  let handoverForShutdown: { client: DynamoDBClient; tableName: string; instanceId: string; cellId: string } | null = null;
  let handoverBaseline: HandoverRecord | null = null;
  let announcedAtMs = 0;
  const [announceId, resumed] = [Date.now(), wasWriter(cfg.dbDir)];
  const handoverClient = cfg.handoverEnabled ? createHandoverClient(cfg) : null;
  if (handoverClient !== null) {
    const instanceId = (await readInstanceId()) ?? "";
    handoverForShutdown = { client: handoverClient, tableName: cfg.registryTable, instanceId, cellId: cfg.cellId };
    // A restarted WRITER is nobody's replacement (handover/writer-marker.ts).
    if (resumed) console.log(JSON.stringify({ type: "handover", event: "gate-skipped", reason: "this instance was the writer" }));
    else handoverBaseline = await announceWarming(handoverForShutdown, { instanceId, atMs: announceId });
    announcedAtMs = Date.now();
  }

  // 1-3. registry + restore-then-serve (throws on any failure = boot aborts)
  const servedAtBoot = await sync.bootRestoreAll();
  bootTimer.mark("restore");

  // 4. bind the HTTP API
  let shutdownRef: Shutdown | null = null;
  const cells = createCells(cfg);
  const server = buildServer({
    cfg,
    registry,
    manager,
    txRegistry,
    limiter,
    quota,
    ...(cells.relay ? { relay: cells.relay } : {}),
    ensureServed: (orgId, appId) => sync.ensureServed(orgId, appId),
    recordWrite: (orgId, appId, changed) => writeStats.record(orgId, appId, changed),
    onAdminSync: () => sync.syncOnce(),
    onDeleteApp: (orgId, appId) => sync.removeApp(orgId, appId),
    health: () => ({ litestream: litestream.healthy ? "up" : "down", vec: vecVersion }),
    isDraining: () => shutdownRef?.isDraining ?? false,
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  bootTimer.mark("listen");
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : cfg.port;

  // 4-bis. HOT HANDOVER (t_vm_zero_cut_handover) — off unless switched on.
  //
  // ⚠️ THE POSITION IS THE SAFETY PROPERTY: after the port binds (nothing
  // routes here until Cloud Map registration) and BEFORE litestream starts.
  // Replicating before the predecessor has proved it stopped is the
  // dual-writer that terminate-before-launch exists to prevent.
  let watcher: WarmingWatcher | null = null;
  if (handoverForShutdown !== null) {
    const handoverDeps = handoverForShutdown;
    const asgClient = cfg.imdsEnabled ? createLifecycleClient(cfg.awsRegion) : null;
    if (!resumed) await runHandoverGate(cfg, {
      ...handoverDeps,
      baseline: handoverBaseline,
      announcedAtMs,
      announceId,
      completeLaunch: async () => (asgClient ? completeLaunchHook({ client: asgClient }, handoverDeps.instanceId) : false),
      peers: async () => (asgClient ? listPeers({ client: asgClient }, handoverDeps.instanceId) : null),
      servedKeys: () => sync.servedApps.map((a) => appKeyOf(a.orgId, a.appId)),
      catchUpDeps: {
        manager,
        litestream,
        serves: (orgId, appId) => sync.isServed(orgId, appId),
        predatesBoot: (orgId, appId) => sync.hadLocalFileAtBoot(orgId, appId),
        concurrency: cfg.bootRestoreConcurrency,
      },
    });
    // From here on WE are the instance that may have to hand over next.
    watcher = new WarmingWatcher({
      deps: handoverDeps,
      selfInstanceId: handoverDeps.instanceId,
      readStats: () => writeStats.snapshot(),
    });
    watcher.start(cfg.handoverWatchMs);
  }
  bootTimer.mark("handover");

  // 5. continuous replication
  litestream.start(servedAtBoot);
  markWriter(cfg.dbDir);
  bootTimer.mark("litestream");

  // 6. announce ourselves to the API Gateway path (Cloud Map) and to the other
  // cells (`_vms`), only once the API is actually able to answer
  const { cloudMap, peerWatch } = await cells.join(port);
  // The boot ENDS here: until this registration lands, API Gateway has no
  // target and every request is a 500 (see the connector's dataapi-retry.ts).
  bootTimer.mark("register");
  void publishBootTiming(cfg, bootTimer);

  // background loops
  const sweeper = startTxSweeper(cfg, txRegistry, manager);
  const poller = startRegistryPoller(cfg, sync);

  writeStats.start(cfg.writeStatsFlushMs);

  const evictionSweep = startEvictionSweep({ cfg, sync, writeStats, txRegistry, limiter });

  const heartbeat = new Heartbeat(cfg, () => litestream.healthy, undefined, {
    litestreamPid: () => litestream.childPid,
    servedApps: () => sync.servedApps.length,
    replicatedApps: () => sync.replicatedApps.length,
    diskPath: cfg.dbDir,
  });
  heartbeat.start();

  logDiskVolume(cfg.dbDir);

  const shutdown = new Shutdown({ cfg, server, manager, sync, litestream, txRegistry, cloudMap, peerWatch, watcher, writeStats, handover: handoverForShutdown });
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
      watcher?.stop();
      if (evictionSweep) clearInterval(evictionSweep);
      heartbeat.stop();
      await peerWatch?.retire();
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
