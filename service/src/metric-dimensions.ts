// Every metric of this service carries the same dimensions, and with several
// cells in one stack they must tell the cells apart (t_dbmove_p3_relay_cells):
// two VMs beating into ONE `{stack}` series keep its Sum ≥ 1 while either
// lives, so the dead-man switch would sleep through the death of a cell.
//
// The ORIGIN cell keeps `{stack}` alone, on purpose. CloudWatch treats a new
// dimension set as a new metric: adding `cell` there would orphan every
// existing alarm and dashboard for the length of a roll — the old instance
// still publishing the old series while the alarm already watches the new one.
import { ORIGIN_CELL } from "./placement.ts";

export interface Dimension {
  Name: string;
  Value: string;
}

export function metricDimensions(cfg: { heartbeatDimension: string; cellId: string }): Dimension[] {
  const dims = [{ Name: "stack", Value: cfg.heartbeatDimension }];
  if (cfg.cellId !== ORIGIN_CELL) dims.push({ Name: "cell", Value: cfg.cellId });
  return dims;
}
