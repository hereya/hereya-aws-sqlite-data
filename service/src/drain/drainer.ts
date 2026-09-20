// Emptying THIS cell into another one (t_dbmove_p5_drain_ops).
//
// The draining cell drives its own drain: the mover is here (move/mover.ts), so
// are the file sizes and the open transactions, and a replacement instance that
// boots mid-drain finds the order in the table and simply carries on. Nothing
// below decides where a database is — it only ASKS the mover, app by app, and
// the mover's two conditional writes remain the whole safety rule.
//
// Three rules of its own:
//
// 1. NO SERIAL LOOP. `concurrency` moves at a time (the boot restore's width):
//    100 apps × ~1.3 s one after the other is two minutes of somebody waiting.
// 2. A FAILED MOVE IS NOT FREE — the app was paused, then resumed. So a pass
//    stops after BREAKER_FAILURES failures in a row (a target that is down would
//    otherwise pause every app of the cell, every tick) and the next passes are
//    spaced out. A timer only decides to TRY again.
// 3. AN ORDER STAYS IN FORCE UNTIL LIFTED. An app born here after the cell was
//    emptied (no placement row = the origin) is moved at the next tick, and the
//    cell stays out of Cloud Map: it is still reachable through the relay.
import { appKeyOf } from "../apps.ts";
import { ServiceError } from "../errors.ts";
import type { MoveRequest, MoveResult } from "../move/mover.ts";
import type { AppRef } from "../registry.ts";
import type { DrainOrder, DrainProgress, DrainStore } from "./store.ts";

export const BREAKER_FAILURES = 3;
const MAX_SKIPPED_TICKS = 16;

/** Whether this instance is a target of the gateway (Cloud Map). */
export interface Presence {
  readonly inCloudMap: boolean;
  leave(): Promise<void>;
  enter(): Promise<void>;
}

export interface DrainerDeps {
  cellId: string;
  instanceId: () => string;
  store: DrainStore;
  /** The active apps this cell holds, read NOW (placement reloaded). */
  listHeld: () => Promise<AppRef[]>;
  sizeOf: (orgId: string, appId: string) => number;
  isMoving: (appKey: string) => boolean;
  moveOut: (req: MoveRequest) => Promise<MoveResult>;
  /** Does the target cell have a serving instance? Asked before every pass. */
  targetReachable: (toCell: string) => Promise<boolean>;
  /** Null until the instance has joined (boot step 6), and in local-dev mode. */
  presence: () => Presence | null;
  isShuttingDown: () => boolean;
  /** Ms since the last request that came through the gateway; null = none yet. */
  gatewayQuietMs: () => number | null;
  concurrency: number;
  maxBytes: number;
  now?: () => number;
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "drain", ...event }));
}

export class Drainer {
  private readonly deps: DrainerDeps;
  private running = false;
  private moved = 0;
  private failed = 0;
  private passes = 0;
  private blockedPasses = 0;
  private skipTicks = 0;
  private orderedAtMs: number | null = null;

  constructor(deps: DrainerDeps) {
    this.deps = deps;
  }

  /** One look at the order, and one pass if there is one. NEVER throws. */
  async tick(): Promise<void> {
    if (this.running || this.deps.isShuttingDown()) return;
    this.running = true;
    try {
      await this.once();
    } catch (err) {
      // Blind = no judgement: an unreadable order neither starts a drain nor
      // puts the cell back into Cloud Map.
      log({ event: "tick-failed", message: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async once(): Promise<void> {
    const { deps } = this;
    const order = await deps.store.readOrder(deps.cellId);
    if (order === null) {
      this.orderedAtMs = null;
      const presence = deps.presence();
      if (presence && !presence.inCloudMap) {
        await presence.enter();
        log({ event: "order-lifted", cellId: deps.cellId });
      }
      return;
    }
    if (order.orderedAtMs !== this.orderedAtMs) {
      // A new order: the counters are its own, and so is the back-off.
      this.orderedAtMs = order.orderedAtMs;
      this.moved = this.failed = this.passes = this.blockedPasses = this.skipTicks = 0;
    }
    if (this.skipTicks > 0) {
      this.skipTicks -= 1;
      return;
    }
    let lastError: string | null = null;
    let held = await deps.listHeld();
    const skippedBig = this.tooBig(order, held);
    const todo = held.filter((a) => !skippedBig.includes(appKeyOf(a.orgId, a.appId)) && !deps.isMoving(appKeyOf(a.orgId, a.appId)));
    if (todo.length > 0) {
      this.passes += 1;
      lastError = order.toCell === deps.cellId ? "the order names this very cell as its target" : null;
      if (lastError === null && !(await deps.targetReachable(order.toCell))) lastError = `cell ${order.toCell} has no serving instance`;
      if (lastError === null) lastError = await this.pass(order, todo);
      held = await deps.listHeld();
    }
    const blocked = lastError !== null && todo.length > 0;
    this.blockedPasses = blocked ? this.blockedPasses + 1 : 0;
    this.skipTicks = blocked ? Math.min(2 ** this.blockedPasses, MAX_SKIPPED_TICKS) : 0;
    const presence = deps.presence();
    if (held.length === 0 && order.leave && presence?.inCloudMap) {
      await presence.leave();
      log({ event: "left-cloudmap", cellId: deps.cellId });
    }
    // Only the databases the order told us to leave remain: nothing more will
    // happen by itself, and the operator must read that, not "draining".
    const onlyBig = held.length > 0 && held.every((a) => skippedBig.includes(appKeyOf(a.orgId, a.appId)));
    if (onlyBig) lastError = `only databases above ${deps.maxBytes} bytes remain (big=skip): force them, or roll the cell with them on it`;
    await this.report(order, held.length, skippedBig, blocked || onlyBig, lastError);
  }

  /** Smallest first: the many cheap moves are not queued behind a long one. */
  private async pass(order: DrainOrder, todo: AppRef[]): Promise<string | null> {
    const { deps } = this;
    const queue = [...todo].sort((a, b) => deps.sizeOf(a.orgId, a.appId) - deps.sizeOf(b.orgId, b.appId));
    let inARow = 0;
    let lastError: string | null = null;
    const worker = async (): Promise<void> => {
      for (let app = queue.shift(); app !== undefined; app = queue.shift()) {
        if (inARow >= BREAKER_FAILURES || deps.isShuttingDown()) return;
        const appKey = appKeyOf(app.orgId, app.appId);
        try {
          const res = await deps.moveOut({ orgId: app.orgId, appId: app.appId, toCell: order.toCell, force: order.big === "force" });
          if (res.status === "moved") {
            this.moved += 1;
            inARow = 0;
            continue;
          }
          lastError = `${appKey}: ${res.reason ?? "resumed"}`;
          inARow += 1;
        } catch (err) {
          lastError = `${appKey}: ${(err as Error).message}`;
          // Refused before anything was written (an open transaction, a move
          // already running): the app was never paused, so it does not count
          // towards the breaker — it is simply tried again at the next pass.
          if (!(err instanceof ServiceError && err.code === "MOVE_ABORTED")) inARow += 1;
        }
        this.failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency, queue.length)) }, worker));
    if (inARow >= BREAKER_FAILURES) log({ event: "pass-stopped", cellId: deps.cellId, toCell: order.toCell, lastError });
    return lastError;
  }

  private tooBig(order: DrainOrder, held: AppRef[]): string[] {
    if (order.big === "force") return [];
    return held.filter((a) => this.deps.sizeOf(a.orgId, a.appId) > this.deps.maxBytes).map((a) => appKeyOf(a.orgId, a.appId));
  }

  private async report(order: DrainOrder, held: number, skippedBig: string[], blocked: boolean, lastError: string | null): Promise<void> {
    const { deps } = this;
    const progress: DrainProgress = {
      cellId: deps.cellId,
      orderedAtMs: order.orderedAtMs,
      toCell: order.toCell,
      instanceId: deps.instanceId(),
      state: held === 0 ? "empty" : blocked ? "blocked" : "draining",
      inCloudMap: deps.presence()?.inCloudMap ?? true,
      gatewayQuietMs: deps.gatewayQuietMs(),
      held,
      moved: this.moved,
      failed: this.failed,
      skippedBig,
      passes: this.passes,
      lastError,
      atMs: (deps.now ?? Date.now)(),
    };
    log({ event: "progress", ...progress });
    try {
      await deps.store.putProgress(progress);
    } catch (err) {
      log({ event: "report-failed", message: (err as Error).message });
    }
  }
}
