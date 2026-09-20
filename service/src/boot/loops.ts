// The background timers a running service keeps: tx expiry sweep, registry
// poll, and the (opt-in) idle-app eviction sweep. Each is `unref`ed so it can
// never be the thing that holds the process open.
import type { AppManager } from "../apps.ts";
import type { Config } from "../config.ts";
import { daysToMs } from "../eviction.ts";
import type { Limiter } from "../limits.ts";
import type { AppSync } from "../sync.ts";
import type { TxRegistry } from "../tx.ts";
import type { WriteStats } from "../write-stats.ts";

export function startTxSweeper(cfg: Config, txRegistry: TxRegistry, manager: AppManager): NodeJS.Timeout {
  const sweeper = setInterval(() => {
    for (const expired of txRegistry.sweep()) {
      const [orgId, appId] = expired.appKey.split("/") as [string, string];
      void manager.workerFor(orgId, appId).control("rollback", cfg.txOpTimeoutMs).catch(() => {});
      console.log(JSON.stringify({ type: "tx-expired", appKey: expired.appKey, txId: expired.txId }));
    }
  }, 2000);
  sweeper.unref();
  return sweeper;
}

export function startRegistryPoller(cfg: Config, sync: AppSync, beforeSync?: () => Promise<void> | undefined): NodeJS.Timeout {
  const poller = setInterval(() => {
    void beforeSync?.();
    void sync.syncOnce().catch((err) => {
      console.error(JSON.stringify({ type: "sync", error: (err as Error).message }));
    });
  }, cfg.registryPollSeconds * 1000);
  poller.unref();
  return poller;
}

/**
 * Eviction sweep: stop replicating apps that have not changed in days. Off
 * unless EVICTION_IDLE_DAYS is set — see src/eviction.ts for why the
 * threshold IS the safety argument, not just an economic one.
 */
export function startEvictionSweep(args: {
  cfg: Config;
  sync: AppSync;
  writeStats: WriteStats;
  txRegistry: TxRegistry;
  limiter: Limiter;
}): NodeJS.Timeout | null {
  const { cfg, sync, writeStats, txRegistry, limiter } = args;
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
  return evictionSweep;
}
