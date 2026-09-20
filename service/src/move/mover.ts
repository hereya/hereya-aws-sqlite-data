// Moving ONE database to another cell — the side it LEAVES (t_dbmove_p4_move).
//
//   begin (row: moving) → hold the app → drain → close the worker → litestream
//   sync + stop, OBSERVED → row: a_stopped → ask the target → READ THE ROW.
//
// Two rules, and everything below is one of them:
//
// 1. THE OUTCOME IS READ, NEVER ASSUMED. Whatever the target answered — or did
//    not — this cell decides "resumed" or "moved" from a strongly consistent
//    read of the row, and the only way back to A is a `cancel` that DynamoDB
//    accepted (record.ts). A timeout, a 500, a lost answer: all of them lead to
//    the same read.
// 2. UNTIL THE OUTCOME IS KNOWN THE APP IS CLOSED HERE (503, "nothing ran").
//    The hold parks statements for at most MAX_HOLD_MS; past it they are
//    refused, not run — litestream has let go of the file, and a statement
//    that ran now would be acknowledged and lost.
import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { appKeyOf } from "../apps.ts";
import { ServiceError } from "../errors.ts";
import { MAX_HOLD_MS, type Limiter } from "../limits.ts";
import { crashPoint } from "./crash-points.ts";
import type { MoveRecord } from "./record.ts";

export type MoveOutcome = "moved" | "resumed";

export interface MoveOutDeps {
  cellId: string;
  record: MoveRecord;
  limiter: Pick<Limiter, "hold" | "close" | "reopen" | "inFlight">;
  hasOpenTx: (appKey: string) => boolean;
  dbPath: (orgId: string, appId: string) => string;
  served: {
    isPending(orgId: string, appId: string): boolean;
    markDeparting(orgId: string, appId: string): void;
    detach(orgId: string, appId: string): Promise<void>;
    reattach(orgId: string, appId: string): Promise<void>;
    forget(orgId: string, appId: string): void;
  };
  /** Ask the target cell to take the app. Its answer is logged, never trusted. */
  askTarget: (toCell: string, body: Record<string, unknown>) => Promise<number>;
  reloadPlacement: () => void;
  /** How long statements and an open transaction get to finish before the move gives up. */
  drainMs: number;
  /** How long statements are PARKED; past it they are refused (rule 2). Default MAX_HOLD_MS. */
  holdMs?: number;
  /** Above this, the restore on the target outlasts the hold: refused unless forced. */
  maxBytes: number;
}

export interface MoveRequest {
  orgId: string;
  appId: string;
  toCell: string;
  force?: boolean;
  crashAt?: string;
}

export interface MoveResult {
  status: MoveOutcome;
  fromCell: string;
  toCell: string;
  version: number;
  pauseMs: number;
  reason?: string;
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "move", side: "out", ...event }));
}

class Abort extends Error {}

export class Mover {
  private readonly deps: MoveOutDeps;
  /** Moves this process is driving — what a sweep must leave alone. */
  readonly active = new Set<string>();

  constructor(deps: MoveOutDeps) {
    this.deps = deps;
  }

  async moveOut(req: MoveRequest): Promise<MoveResult> {
    const { deps } = this;
    const { orgId, appId, toCell } = req;
    const appKey = appKeyOf(orgId, appId);
    if (toCell === deps.cellId) throw new ServiceError("BAD_REQUEST", "the app is already on this cell");
    if (this.active.has(appKey)) throw new ServiceError("MOVE_ABORTED", "this app is already being moved");
    const bytes = sizeOf(deps.dbPath(orgId, appId));
    if (bytes > deps.maxBytes && req.force !== true) {
      throw new ServiceError("MOVE_ABORTED", `database is ${bytes} bytes (limit ${deps.maxBytes}): its restore would outlast the write hold; pass force to accept a longer pause`);
    }
    // An open transaction lives in THIS process's memory and cannot follow the
    // file. It is waited for WITHOUT a hold — under one its COMMIT would park.
    if (!(await this.until(() => !deps.hasOpenTx(appKey)))) {
      throw new ServiceError("MOVE_ABORTED", "the app has an open transaction; nothing was changed");
    }

    this.active.add(appKey);
    let version: number | null = null;
    let hold: ReturnType<Limiter["hold"]> | null = null;
    const startedAt = Date.now();
    let outcome: MoveOutcome = "resumed";
    let reason: string | undefined;
    try {
      version = await deps.record.begin(orgId, appId, deps.cellId, toCell);
      if (version === null) throw new ServiceError("MOVE_ABORTED", "the placement row is not this cell's, or already carries a move");
      crashPoint(req.crashAt, "after-begin");

      hold = deps.limiter.hold(appKey, deps.holdMs ?? MAX_HOLD_MS);
      deps.limiter.close(appKey, "departing");
      deps.served.markDeparting(orgId, appId);
      const drained = await this.until(
        () => deps.limiter.inFlight(appKey) === 0 && !deps.served.isPending(orgId, appId) && !deps.hasOpenTx(appKey),
      );
      if (!drained) throw new Abort("statements or a transaction did not drain in time");

      try {
        await deps.served.detach(orgId, appId);
      } catch (err) {
        throw new Abort(`litestream stop not observed: ${(err as Error).message}`);
      }
      crashPoint(req.crashAt, "after-detach");
      if (!(await deps.record.reportStopped(orgId, appId, version))) throw new Abort("the move was cancelled by another writer");
      crashPoint(req.crashAt, "after-a-stopped");

      const answered = await deps
        .askTarget(toCell, { org_id: orgId, app_id: appId, from_cell: deps.cellId, version, crash_at: req.crashAt })
        .catch((err: Error) => err.message);
      log({ event: "target-answered", appKey, toCell, answered });
      crashPoint(req.crashAt, "after-ask");
    } catch (err) {
      // Nothing was written: nothing to settle. Past `begin`, EVERY failure —
      // an Abort or a throw we did not foresee — goes through the same read.
      if (version === null) {
        this.active.delete(appKey);
        throw err;
      }
      reason = (err as Error).message;
    }

    try {
      outcome = await this.resolve(orgId, appId, version!);
      if (outcome === "moved") {
        deps.reloadPlacement();
        deps.served.forget(orgId, appId);
        deps.limiter.close(appKey, "moved");
      } else {
        await deps.served.reattach(orgId, appId);
        deps.limiter.reopen(appKey);
      }
    } finally {
      hold?.release();
      this.active.delete(appKey);
    }
    const result: MoveResult = { status: outcome, fromCell: deps.cellId, toCell, version: version!, pauseMs: Date.now() - startedAt };
    if (outcome === "resumed") result.reason = reason ?? "the target did not claim the app";
    log({ event: outcome, appKey, ...result });
    return result;
  }

  /**
   * Rule 1. Loops until the row can be read: while it cannot, nobody knows who
   * holds the app, and it stays closed here — which is the correct answer.
   */
  private async resolve(orgId: string, appId: string, version: number): Promise<MoveOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await this.deps.record.read(orgId, appId);
        if (row === null) return "resumed";
        const holder = row.phase === "b_started" ? row.targetVm : row.vmId;
        if (holder !== this.deps.cellId) return "moved";
        if (row.phase === null || row.version !== version) return "resumed";
        if (await this.deps.record.cancel(orgId, appId, version)) return "resumed";
      } catch (err) {
        log({ event: "resolve-retry", appKey: appKeyOf(orgId, appId), attempt, message: (err as Error).message });
      }
      await sleep(Math.min(250 * 2 ** Math.min(attempt, 4), 4_000));
    }
  }

  private async until(done: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this.deps.drainMs;
    while (!done()) {
      if (Date.now() >= deadline) return false;
      await sleep(10);
    }
    return true;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
