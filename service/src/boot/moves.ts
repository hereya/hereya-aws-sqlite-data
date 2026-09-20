// Wiring of the database moves (move/) — kept out of service.ts (220-line cap).
import type { AppManager } from "../apps.ts";
import type { Config } from "../config.ts";
import type { Limiter } from "../limits.ts";
import { Arrival } from "../move/arrival.ts";
import { Mover } from "../move/mover.ts";
import { DdbMoveRecord } from "../move/record.ts";
import { sweepMoves } from "../move/sweep.ts";
import type { Registry } from "../registry.ts";
import type { Relay } from "../relay.ts";
import type { Moves } from "../server/move-routes.ts";
import type { AppSync } from "../sync.ts";
import type { TxRegistry } from "../tx.ts";

export interface MovesRuntime {
  routes: Moves;
  /** Settle the moves no live process is driving. NEVER throws: a boot must not
   *  abort over it — placement reads an unsettled row safely either way. */
  sweep(): Promise<void>;
}

export function createMoves(args: {
  cfg: Config;
  registry: Registry;
  manager: AppManager;
  limiter: Limiter;
  sync: AppSync;
  txRegistry: TxRegistry;
  relay: Relay | null;
}): MovesRuntime | null {
  const { cfg, registry, manager, limiter, sync, txRegistry, relay } = args;
  // No table, or no way to reach a peer: there is nowhere to move anything.
  if (cfg.registryMode !== "ddb" || !cfg.registryTable || relay === null) return null;
  const record = new DdbMoveRecord({ tableName: cfg.registryTable, region: cfg.awsRegion });
  const reloadPlacement = (): void => registry.reloadPlacement?.();
  const mover = new Mover({
    cellId: cfg.cellId,
    record,
    limiter,
    hasOpenTx: (appKey) => txRegistry.hasOpenTx(appKey),
    dbPath: (orgId, appId) => manager.dbPath(orgId, appId),
    served: sync.move,
    askTarget: async (toCell, body) =>
      (await relay.forward(toCell, { method: "POST", path: "/admin/move-in", body: JSON.stringify(body) })).status,
    reloadPlacement,
    drainMs: cfg.moveDrainMs,
    maxBytes: cfg.moveMaxBytes,
  });
  const arrival = new Arrival({
    cellId: cfg.cellId,
    record,
    limiter,
    clearForArrival: (orgId, appId) => sync.move.clearForArrival(orgId, appId),
    ensureServed: (orgId, appId) => sync.ensureServed(orgId, appId),
    reloadPlacement,
  });
  return {
    routes: { out: mover, in: arrival },
    sweep: async () => {
      try {
        const settled = await sweepMoves({
          cellId: cfg.cellId,
          record,
          isActive: (key) => mover.active.has(key) || arrival.active.has(key),
          dbDir: cfg.dbDir,
          keepMs: cfg.moveKeepMs,
        });
        if (settled.cancelled + settled.finalized > 0) reloadPlacement();
      } catch (err) {
        console.error(JSON.stringify({ type: "move", event: "sweep-failed", message: (err as Error).message }));
      }
    },
  };
}
