// The queue rule that keeps an app's worker out of SQLite's busy handler.
//
// A worker is ONE synchronous process with two connections: autocommit
// statements run on one, an explicit transaction (BEGIN IMMEDIATE) on the
// other. A transaction spans several requests, and between two of them its
// connection keeps the write lock while the worker sits idle. An autocommit
// WRITE handed to the worker in that gap sleeps in the busy handler — inside
// the very process that would have to run the transaction's next statement or
// its COMMIT. Nothing can end the wait but the busy timeout: the write always
// failed "database is locked", and every request queued behind it (reads too:
// the queue is serial) waited as long.
//
// So, while the worker reports its transaction connection inside a
// transaction, an autocommit write stays in the parent's queue:
//
//   * the transaction's own jobs, and BEGIN/COMMIT/ROLLBACK, run as before;
//   * autocommit READS run as before — WAL never blocked them, only the queue;
//   * held writes keep their place: once the transaction is over the queue is
//     taken from its head again, so they run in arrival order, before anything
//     that arrived after them and has not run yet;
//   * a held write does not wait for ever: after its own time limit it is
//     answered QUERY_TIMEOUT and removed — it never runs.
//
// "Open" is what the WORKER says after each job (sql-worker.ts `tx`), not what
// the tx registry believes: it is the lock that matters, and the two can
// differ (a COMMIT that failed leaves it held; a dead worker has dropped it).
//
// What counts as a write is `sqlMutates` (fence.ts): a statement is a READ only
// if it is recognised as one, so anything unrecognised is held. `CREATE … IF
// NOT EXISTS` is a read there, and stays one here: on an existing object it
// takes no lock and has always passed during a transaction. When it does have
// to create the object it still meets the lock, as before.
import { sqlMutates } from "../fence.ts";

export interface HoldableJob {
  msg: Record<string, unknown>;
  timeoutMs: number;
}

export type HoldEnd = "tx-ended" | "worker-gone" | "closed";

/** An autocommit statement that needs the write lock. */
export function isAutocommitWrite(msg: Record<string, unknown>): boolean {
  return msg.action === "exec" && msg.useTx !== true && sqlMutates(String(msg.sql ?? ""));
}

export class TxHold<J extends HoldableJob> {
  private open = false;
  private readonly held = new Map<J, { since: number; timer: NodeJS.Timeout }>();
  private readonly appKey: string;
  private readonly onTimeout: (job: J) => void;

  constructor(appKey: string, onTimeout: (job: J) => void) {
    this.appKey = appKey;
    this.onTimeout = onTimeout;
  }

  /** The worker's transaction state, as of its last answer (false once it is gone). */
  set(open: boolean, why: HoldEnd = "tx-ended"): void {
    this.open = open;
    if (open || this.held.size === 0) return;
    const now = Date.now();
    let waitedMs = 0;
    for (const { since, timer } of this.held.values()) {
      clearTimeout(timer);
      waitedMs = Math.max(waitedMs, now - since);
    }
    this.log(why, this.held.size, waitedMs);
    this.held.clear();
  }

  /** True = this job must stay in the queue for now. Costs one test when no transaction is open. */
  holds(job: J): boolean {
    if (!this.open) return false;
    if (this.held.has(job)) return true;
    if (!isAutocommitWrite(job.msg)) return false;
    const timer = setTimeout(() => this.expire(job), job.timeoutMs);
    timer.unref();
    this.held.set(job, { since: Date.now(), timer });
    return true;
  }

  get size(): number {
    return this.held.size;
  }

  private expire(job: J): void {
    const entry = this.held.get(job);
    if (!entry) return;
    this.held.delete(job);
    this.log("timeout", 1, Date.now() - entry.since);
    this.onTimeout(job);
  }

  /** One line per episode, never the SQL: `held` writes waited up to `waitedMs`. */
  private log(event: HoldEnd | "timeout", held: number, waitedMs: number): void {
    console.log(JSON.stringify({ type: "tx-hold", ts: new Date().toISOString(), appKey: this.appKey, event, held, waitedMs }));
  }
}
