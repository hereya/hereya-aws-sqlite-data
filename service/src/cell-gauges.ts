// What a cell measures beyond its own capacity (t_dbmove_p5_drain_ops), published
// by the heartbeat under the cell's dimensions:
//
//   ReplicationLagMaxSeconds — the worst per-database litestream lag (control.ts)
//   MovesStuck               — moves naming this cell that do not end (move/stuck.ts)
//   RelayedRequests / RelayFailures — per tick; failures are what is alarmed on,
//     because with N cells (N-1)/N of the traffic is relayed BY DESIGN: the rate
//     is a fact about the gateway's spread, only the failures are a fault.
import type { Gauge } from "./heartbeat.ts";

export interface CellGaugeSources {
  replicationLagSeconds: () => Promise<number | null>;
  stuckMoves: (() => number) | null;
  relayStats: (() => { forwarded: number; failed: number }) | null;
}

export function createCellGauges(sources: CellGaugeSources): () => Promise<Gauge[]> {
  let last = { forwarded: 0, failed: 0 };
  return async () => {
    const gauges: Gauge[] = [{ name: "ReplicationLagMaxSeconds", unit: "Seconds", value: await sources.replicationLagSeconds() }];
    if (sources.stuckMoves) gauges.push({ name: "MovesStuck", unit: "Count", value: sources.stuckMoves() });
    if (sources.relayStats) {
      const now = { ...sources.relayStats() };
      gauges.push({ name: "RelayedRequests", unit: "Count", value: now.forwarded - last.forwarded });
      gauges.push({ name: "RelayFailures", unit: "Count", value: now.failed - last.failed });
      last = now;
    }
    return gauges;
  };
}
