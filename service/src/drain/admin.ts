// The operator's side of a drain (t_dbmove_p5_drain_ops): write or lift the
// ORDER, and read where things stand. Any cell can answer — an order is a row,
// and the cell it names finds it at its next tick (poked at once by the
// broadcast `/admin/sync` the route sends afterwards).
import { ServiceError } from "../errors.ts";
import type { VmRow } from "../vms.ts";
import type { DrainOrder, DrainProgress, DrainStore } from "./store.ts";

export interface DrainStartRequest {
  cellId: string;
  toCell: string;
  big: "skip" | "force";
  leave: boolean;
}

export interface CellStatus {
  cellId: string;
  instances: { instanceId: string; state: string }[];
  order: DrainOrder | null;
  progress: DrainProgress | null;
}

export interface DrainAdminDeps {
  cellId: string;
  store: DrainStore;
  /** Every `_vms` row, read now. */
  vms: () => Promise<VmRow[]>;
  now?: () => number;
}

export class DrainAdmin {
  private readonly deps: DrainAdminDeps;

  constructor(deps: DrainAdminDeps) {
    this.deps = deps;
  }

  async start(req: DrainStartRequest): Promise<CellStatus> {
    const { deps } = this;
    if (req.cellId === req.toCell) throw new ServiceError("BAD_REQUEST", "a cell cannot be drained into itself");
    const serving = new Set((await deps.vms()).filter((r) => r.state === "serving").map((r) => r.cellId));
    serving.add(deps.cellId);
    for (const cell of [req.cellId, req.toCell]) {
      if (!serving.has(cell)) throw new ServiceError("BAD_REQUEST", `cell ${cell} has no serving instance`);
    }
    // A into B while B empties itself into A is two cells passing the same
    // databases back and forth, each move a pause for its app.
    if ((await deps.store.readOrder(req.toCell)) !== null) {
      throw new ServiceError("BAD_REQUEST", `cell ${req.toCell} is itself being drained: lift that order first`);
    }
    await deps.store.putOrder({ ...req, orderedAtMs: (deps.now ?? Date.now)() });
    return this.statusOf(req.cellId, await deps.vms());
  }

  async stop(cellId: string): Promise<CellStatus> {
    await this.deps.store.deleteOrder(cellId);
    return this.statusOf(cellId, await this.deps.vms());
  }

  /** One cell, or every cell the directory knows. */
  async status(cellId?: string): Promise<{ cells: CellStatus[] }> {
    const rows = await this.deps.vms();
    const cellIds = cellId !== undefined ? [cellId] : [...new Set([this.deps.cellId, ...rows.map((r) => r.cellId)])].sort();
    return { cells: await Promise.all(cellIds.map((id) => this.statusOf(id, rows))) };
  }

  private async statusOf(cellId: string, rows: VmRow[]): Promise<CellStatus> {
    const [order, progress] = await Promise.all([this.deps.store.readOrder(cellId), this.deps.store.readProgress(cellId)]);
    const instances = rows.filter((r) => r.cellId === cellId).map((r) => ({ instanceId: r.instanceId, state: r.state }));
    return { cellId, instances, order, progress };
  }
}
