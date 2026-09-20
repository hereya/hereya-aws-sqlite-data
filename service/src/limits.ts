import { ServiceError } from "./errors.ts";

export interface LimiterOptions {
  maxPerApp: number;
  maxTotal: number;
}

/**
 * In-flight request accounting: a queued-or-executing request holds one slot
 * for its app and one global slot. A flooding app hits its own cap (429) long
 * before it can exhaust the global pool that other apps share.
 */
/** A hold never outlives this, whatever its caller asked for: a forgotten hold
 *  must not be able to freeze an app past the callers' own request ceiling. */
export const MAX_HOLD_MS = 10_000;

export interface AppHold {
  /**
   * Let the app's statements through again. Returns whether the hold was STILL
   * IN FORCE — false means it had already expired and statements have been
   * running since, so whatever the caller did under it was not exclusive.
   */
  release(): boolean;
}

/**
 * What a woken statement finds when the hold it waited on is over and the app
 * did NOT simply resume (move/mover.ts):
 * - `departing` — the move is undecided (the hold expired before the mover
 *   could read the outcome). Nothing may run: 503, "nothing ran, retry".
 * - `moved` — another cell holds the app now: 421, which build.ts relays.
 */
export type ClosedState = "departing" | "moved";

export class Limiter {
  private readonly closed = new Map<string, ClosedState>();
  private readonly holds = new Map<string, { done: Promise<void>; open: () => void }>();
  private readonly perApp = new Map<string, number>();
  private total = 0;
  private readonly opts: LimiterOptions;

  constructor(opts: LimiterOptions) {
    this.opts = opts;
  }

  acquire(appKey: string): void {
    const current = this.perApp.get(appKey) ?? 0;
    if (current >= this.opts.maxPerApp) {
      throw new ServiceError("THROTTLED", `too many in-flight requests for this app (max ${this.opts.maxPerApp})`);
    }
    if (this.total >= this.opts.maxTotal) {
      throw new ServiceError("THROTTLED", `service is at its global in-flight limit (max ${this.opts.maxTotal})`);
    }
    this.perApp.set(appKey, current + 1);
    this.total += 1;
  }

  /**
   * What every data route calls instead of `acquire`: wait out a hold on this
   * app, then take the slot. There is NO await between the wake-up and the
   * slot, and that is the point — once `hold` has returned, a statement is
   * either counted by `inFlight` or parked here. Nothing is in between, which
   * is the gap the eviction sweep needs a 5-minute grace to cover
   * (`EVICT_TOUCH_GRACE_MS`); a database move cannot afford one.
   */
  async admit(appKey: string): Promise<void> {
    for (let held = this.holds.get(appKey); held; held = this.holds.get(appKey)) await held.done;
    this.assertOpen(appKey);
    this.acquire(appKey);
  }

  /** The gate's half of a hold: wait it out WITHOUT taking a slot, so that
   *  placement is re-read after the move and not before (server/gate.ts). */
  async whileHeld(appKey: string): Promise<void> {
    for (let held = this.holds.get(appKey); held; held = this.holds.get(appKey)) await held.done;
    this.assertOpen(appKey);
  }

  /**
   * Close the app to statements for as long as a move is undecided, or for
   * good once it has left. Outlives the hold ON PURPOSE: a hold expires by
   * itself (MAX_HOLD_MS) and what it parked must then be refused, never run —
   * this cell has stopped replicating the file.
   */
  close(appKey: string, state: ClosedState): void {
    this.closed.set(appKey, state);
  }

  reopen(appKey: string): void {
    this.closed.delete(appKey);
  }

  assertOpen(appKey: string): void {
    const state = this.closed.get(appKey);
    if (state === "departing") throw new ServiceError("UNAVAILABLE", "this app is being moved to another cell; retry shortly");
    if (state === "moved") throw new ServiceError("MISPLACED", "this app has moved to another cell");
  }

  /**
   * Park this app's NEW statements (reads included — a route cannot tell them
   * apart before running them) until `release`, or `maxMs` at most. Statements
   * already holding a slot run on: the caller drains them by watching
   * `inFlight`. One hold per app; a second caller is refused, never queued.
   */
  hold(appKey: string, maxMs: number): AppHold {
    if (this.holds.has(appKey)) throw new ServiceError("UNAVAILABLE", "this app is already held");
    let open!: () => void;
    const done = new Promise<void>((resolve) => (open = resolve));
    const entry = { done, open };
    this.holds.set(appKey, entry);
    const end = (): boolean => {
      if (this.holds.get(appKey) !== entry) return false;
      this.holds.delete(appKey);
      clearTimeout(timer);
      open();
      return true;
    };
    const timer = setTimeout(() => {
      if (end()) console.warn(JSON.stringify({ type: "limiter", event: "hold-expired", appKey, maxMs }));
    }, Math.min(Math.max(0, maxMs), MAX_HOLD_MS));
    timer.unref();
    return { release: end };
  }

  isHeld(appKey: string): boolean {
    return this.holds.has(appKey);
  }

  release(appKey: string): void {
    const current = this.perApp.get(appKey) ?? 0;
    if (current <= 1) this.perApp.delete(appKey);
    else this.perApp.set(appKey, current - 1);
    if (this.total > 0) this.total -= 1;
  }

  inFlight(appKey: string): number {
    return this.perApp.get(appKey) ?? 0;
  }

  get totalInFlight(): number {
    return this.total;
  }
}
