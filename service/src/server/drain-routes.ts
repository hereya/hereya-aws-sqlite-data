// The two routes of a cell drain (t_dbmove_p5_drain_ops), both through the gateway:
//
//   POST /admin/drain-cell    { cell, action: "start", to_cell, big?, leave? } | { cell, action: "stop" }
//   POST /admin/drain-status  { cell? }
//
// Neither names an app, so neither has a holder: whichever cell receives it
// answers (an order is a row in the table, not a call to the drained cell).
import type { DrainAdmin, DrainStartRequest } from "../drain/admin.ts";
import { ServiceError } from "../errors.ts";

export interface Drains {
  admin: Pick<DrainAdmin, "start" | "stop" | "status">;
  /** Look at the orders NOW instead of at the next registry poll. */
  poke: () => void;
}

const CELL_ID = /^[A-Za-z0-9_-]{1,32}$/;

function cellOf(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || !CELL_ID.test(value)) throw new ServiceError("BAD_REQUEST", `${field} is required (a cell id)`);
  return value;
}

export type DrainCellRequest = ({ action: "start" } & DrainStartRequest) | { action: "stop"; cellId: string };

export function parseDrainCell(body: unknown): DrainCellRequest {
  if (typeof body !== "object" || body === null) throw new ServiceError("BAD_REQUEST", "a JSON object is required");
  const obj = body as Record<string, unknown>;
  const cellId = cellOf(obj, "cell");
  if (obj.action === "stop") return { action: "stop", cellId };
  if (obj.action !== "start") throw new ServiceError("BAD_REQUEST", 'action is required ("start" or "stop")');
  if (obj.big !== undefined && obj.big !== "skip" && obj.big !== "force") {
    throw new ServiceError("BAD_REQUEST", 'big must be "skip" (default) or "force"');
  }
  return {
    action: "start",
    cellId,
    toCell: cellOf(obj, "to_cell"),
    big: obj.big === "force" ? "force" : "skip",
    // Out of Cloud Map once empty unless told otherwise: that is what makes
    // the roll of an emptied cell invisible.
    leave: obj.leave !== false,
  };
}

export function parseDrainStatus(body: unknown): { cellId?: string } {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return obj.cell === undefined ? {} : { cellId: cellOf(obj, "cell") };
}
