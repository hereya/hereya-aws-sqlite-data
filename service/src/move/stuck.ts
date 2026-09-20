// A move that does not end (t_dbmove_p5_drain_ops).
//
// A move is a few seconds; its row carries a phase for exactly that long. One
// that still carries the SAME move (same key, same version) sweep after sweep
// is a database nobody serves: closed on A, not yet open on B. Nothing here
// settles it — sweep.ts and the conditional writes do that — this only COUNTS,
// so that an alarm can say it.
//
// Counted in OUR sweeps, never in seconds of somebody else's clock: a row has no
// timestamp, on purpose (handover's rule).
import type { MoveRow } from "./record.ts";

/** Sweeps (one per registry poll, 30 s) a move may be seen in before it counts as stuck. */
export const STUCK_AFTER_SWEEPS = 4;

export class StuckMoves {
  private readonly seen = new Map<string, number>();
  private readonly after: number;

  constructor(after = STUCK_AFTER_SWEEPS) {
    this.after = after;
  }

  observe(rows: MoveRow[]): void {
    const live = new Set(rows.map((r) => `${r.key}#${r.version}`));
    for (const id of this.seen.keys()) if (!live.has(id)) this.seen.delete(id);
    for (const id of live) this.seen.set(id, (this.seen.get(id) ?? 0) + 1);
  }

  get count(): number {
    return [...this.seen.values()].filter((sweeps) => sweeps >= this.after).length;
  }

  get keys(): string[] {
    return [...this.seen].filter(([, sweeps]) => sweeps >= this.after).map(([id]) => id);
  }
}
