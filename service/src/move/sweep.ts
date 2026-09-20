// Settling the moves nobody is driving any more (t_dbmove_p4_move): the process
// that ran them crashed, or was replaced. Runs at boot BEFORE the restore — so
// that placement is read once every row of ours is settled — and then on the
// registry poll.
//
// It never decides anything the conditional writes of record.ts do not: a move
// of ours that has not reached `b_started` is CANCELLED (if the target claimed
// first, the write fails and the app is the target's); a move towards us that
// reached `b_started` is FINALIZED (placement already reads it as ours).
import { sweepMoved } from "../sync/depart.ts";
import type { MoveRecord } from "./record.ts";

export interface SweepDeps {
  cellId: string;
  record: MoveRecord;
  /** Keys a live mover or arrival of THIS process is driving. */
  isActive: (key: string) => boolean;
  dbDir: string;
  keepMs: number;
}

export async function sweepMoves(deps: SweepDeps): Promise<{ cancelled: number; finalized: number; deleted: number }> {
  let cancelled = 0;
  let finalized = 0;
  for (const row of await deps.record.inFlight()) {
    if (deps.isActive(row.key)) continue;
    const slash = row.key.indexOf("/");
    if (slash < 0) continue;
    const [orgId, appId] = [row.key.slice(0, slash), row.key.slice(slash + 1)];
    if (row.vmId === deps.cellId && (row.phase === "moving" || row.phase === "a_stopped")) {
      if (await deps.record.cancel(orgId, appId, row.version)) cancelled += 1;
    } else if (row.targetVm === deps.cellId && row.phase === "b_started") {
      if (await deps.record.finalize(orgId, appId, row.version, deps.cellId)) finalized += 1;
    }
  }
  const deleted = sweepMoved(deps.dbDir, deps.keepMs);
  if (cancelled + finalized + deleted > 0) {
    console.log(JSON.stringify({ type: "move", event: "swept", cancelled, finalized, deleted }));
  }
  return { cancelled, finalized, deleted };
}
