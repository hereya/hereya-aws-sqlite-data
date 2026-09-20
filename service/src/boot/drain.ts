// Wiring of the cell drain (drain/) — kept out of service.ts (220-line cap).
import { statSync } from "node:fs";
import type { AppManager } from "../apps.ts";
import type { Config } from "../config.ts";
import { DrainAdmin } from "../drain/admin.ts";
import { Drainer } from "../drain/drainer.ts";
import { DdbDrainStore } from "../drain/store.ts";
import type { Registry } from "../registry.ts";
import type { Drains } from "../server/drain-routes.ts";
import type { Cells } from "./cells.ts";
import type { MovesRuntime } from "./moves.ts";

export interface DrainRuntime {
  routes: Drains;
  /** Registry poll and `/admin/sync`: look at this cell's order. Never throws. */
  tick(): Promise<void>;
  /**
   * Asked once, just before joining: was this cell emptied and told to stay out
   * of Cloud Map? Unreadable = NO — in discovery a cell can always relay, so
   * walking in is the answer that cannot hurt.
   */
  startsOut(heldAtBoot: number): Promise<boolean>;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function createDrain(args: {
  cfg: Config;
  registry: Registry;
  manager: AppManager;
  cells: Cells;
  moves: MovesRuntime | null;
  isShuttingDown: () => boolean;
}): DrainRuntime | null {
  const { cfg, registry, manager, cells, moves, isShuttingDown } = args;
  const { directory } = cells;
  if (moves === null || directory === null || !cfg.registryTable) return null;
  const store = new DdbDrainStore({ tableName: cfg.registryTable, region: cfg.awsRegion });
  const drainer = new Drainer({
    cellId: cfg.cellId,
    instanceId: () => cells.cloudMap?.registered?.instanceId ?? "unknown",
    store,
    listHeld: async () => {
      registry.reloadPlacement?.();
      return registry.listActive();
    },
    sizeOf: (orgId, appId) => sizeOf(manager.dbPath(orgId, appId)),
    isMoving: (appKey) => moves.mover.active.has(appKey),
    moveOut: (req) => moves.mover.moveOut(req),
    targetReachable: async (toCell) => {
      directory.reload();
      return (await directory.targets(toCell)).length > 0;
    },
    // Null until boot step 6: before it there is nothing to leave.
    presence: () => cells.cloudMap,
    isShuttingDown,
    concurrency: cfg.bootRestoreConcurrency,
    maxBytes: cfg.moveMaxBytes,
  });
  const admin = new DrainAdmin({ cellId: cfg.cellId, store, vms: () => directory.readAll() });
  return {
    routes: { admin, poke: () => void drainer.tick() },
    tick: () => drainer.tick(),
    startsOut: async (heldAtBoot) => {
      if (heldAtBoot > 0) return false;
      try {
        return (await store.readOrder(cfg.cellId))?.leave === true;
      } catch (err) {
        console.error(JSON.stringify({ type: "drain", event: "boot-read-failed", message: (err as Error).message }));
        return false;
      }
    },
  };
}
