// The two routes of a database move (t_dbmove_p4_move).
//
//   POST /admin/move-app  { org_id, app_id, to_cell, force? }   — operator, through the gateway
//   POST /admin/move-in   { org_id, app_id, version }           — cell to cell ONLY
//
// `move-app` needs no routing of its own: build.ts checks placement first, so
// on any other cell it is a MISPLACED and the relay carries it to the holder.
import { ServiceError } from "../errors.ts";
import type { Arrival } from "../move/arrival.ts";
import type { Mover } from "../move/mover.ts";
import { validateTx } from "../validate.ts";

export interface Moves {
  out: Pick<Mover, "moveOut">;
  in: Pick<Arrival, "moveIn">;
}

const CELL_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function parseMoveApp(body: unknown): { orgId: string; appId: string; toCell: string; force: boolean; crashAt?: string } {
  const { orgId, appId } = validateTx(body, false);
  const obj = body as Record<string, unknown>;
  if (typeof obj.to_cell !== "string" || !CELL_ID.test(obj.to_cell)) {
    throw new ServiceError("BAD_REQUEST", "to_cell is required (a cell id)");
  }
  return { orgId, appId, toCell: obj.to_cell, force: obj.force === true, ...crashAt(obj) };
}

export function parseMoveIn(body: unknown): { orgId: string; appId: string; version: number; crashAt?: string } {
  const { orgId, appId } = validateTx(body, false);
  const obj = body as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    throw new ServiceError("BAD_REQUEST", "version is required (the move's row version)");
  }
  return { orgId, appId, version: obj.version, ...crashAt(obj) };
}

function crashAt(obj: Record<string, unknown>): { crashAt?: string } {
  return typeof obj.crash_at === "string" ? { crashAt: obj.crash_at } : {};
}
