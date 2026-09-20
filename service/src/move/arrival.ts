// Moving ONE database to another cell — the side it ARRIVES on (t_dbmove_p4_move).
//
//   check the row → clear any stale local copy → CLAIM (row: b_started) →
//   restore from S3 + register with litestream (`ensureServed`) → finalize.
//
// The order is the safety property, twice:
//
// • CLEAR BEFORE CLAIM. While the row still says A, this cell's gate answers
//   421 for the app and nothing can restore it here. After the claim, relayed
//   statements arrive at once and go through `ensureServed` — which keeps an
//   "existing" local file as is. A copy left from an earlier stay would be
//   served as current data.
// • CLAIM BEFORE RESTORE. The claim is what forbids A to come back (record.ts).
//   Restoring first would open a window where this cell replicates a database
//   A may still cancel and resume: the dual writer. After the claim a crash
//   here changes nothing — the row says the app is ours, and our replacement
//   restores it at boot like any other.
import { appKeyOf } from "../apps.ts";
import { ServiceError } from "../errors.ts";
import type { Limiter } from "../limits.ts";
import { crashPoint } from "./crash-points.ts";
import type { MoveRecord } from "./record.ts";

export interface MoveInDeps {
  cellId: string;
  record: MoveRecord;
  limiter: Pick<Limiter, "reopen">;
  clearForArrival: (orgId: string, appId: string) => Promise<void>;
  ensureServed: (orgId: string, appId: string) => Promise<void>;
  reloadPlacement: () => void;
}

export interface MoveInRequest {
  orgId: string;
  appId: string;
  version: number;
  crashAt?: string;
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "move", side: "in", ...event }));
}

export class Arrival {
  private readonly deps: MoveInDeps;
  /** Arrivals this process is driving — what a sweep must leave alone. */
  readonly active = new Set<string>();

  constructor(deps: MoveInDeps) {
    this.deps = deps;
  }

  async moveIn(req: MoveInRequest): Promise<{ status: "claimed"; version: number; restoreMs: number }> {
    const { deps } = this;
    const { orgId, appId, version } = req;
    const appKey = appKeyOf(orgId, appId);
    if (this.active.has(appKey)) throw new ServiceError("MOVE_ABORTED", "this arrival is already in progress");
    this.active.add(appKey);
    try {
      const row = await deps.record.read(orgId, appId);
      if (row === null || row.version !== version || row.phase !== "a_stopped" || row.targetVm !== deps.cellId) {
        throw new ServiceError("MOVE_ABORTED", "no stopped move towards this cell is written for this app");
      }
      try {
        await deps.clearForArrival(orgId, appId);
      } catch (err) {
        throw new ServiceError("MOVE_ABORTED", (err as Error).message);
      }
      crashPoint(req.crashAt, "in-after-clear");
      if (!(await deps.record.claim(orgId, appId, version, deps.cellId))) {
        throw new ServiceError("MOVE_ABORTED", "the move was cancelled before this cell could claim it");
      }
      // From here the app is OURS, whatever happens next. Errors below are
      // reported but undo nothing: the next statement retries the restore
      // through the ordinary hot-add path.
      crashPoint(req.crashAt, "in-after-claim");
      deps.reloadPlacement();
      deps.limiter.reopen(appKey);
      const startedAt = Date.now();
      await deps.ensureServed(orgId, appId);
      const restoreMs = Date.now() - startedAt;
      crashPoint(req.crashAt, "in-after-restore");
      const finalized = await deps.record.finalize(orgId, appId, version, deps.cellId).catch(() => false);
      log({ event: "arrived", appKey, version, restoreMs, finalized });
      return { status: "claimed", version, restoreMs };
    } finally {
      this.active.delete(appKey);
    }
  }
}
