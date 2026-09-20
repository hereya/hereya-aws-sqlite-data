// Handover records are PER CELL (t_dbmove_p3_relay_cells). A roll is a
// conversation between one cell's departing instance and its replacement; with
// shared keys, cell 1 rolling would read cell 0's report as its own
// predecessor's stop — and start writing beside a live litestream.
//
// The origin cell keeps the bare keys (`current`, `warming`, `ack`): the roll
// that ships this has an old instance on one side and a new one on the other,
// and they must still be talking about the same items.
import { ORIGIN_CELL } from "../placement.ts";

export function cellKey(base: string, cellId: string | undefined): string {
  return cellId === undefined || cellId === ORIGIN_CELL ? base : `${base}#${cellId}`;
}
