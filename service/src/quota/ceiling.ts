// The org quota as a HARD ceiling, inside the worker (t_quota_db_bypass).
// The guard checks the org before a statement runs; this bounds what the
// statement then WRITES — one INSERT…SELECT randomblob() or a trigger behind an
// exempt DELETE could otherwise write gigabytes past the cap. `max_page_count`
// makes SQLite itself answer SQLITE_FULL past it and roll the statement back.
// A transaction gets ONE ceiling, set by its first statement, so N statements
// cannot add up N rooms.
import type { DatabaseSync } from "node:sqlite";

const NO_CEILING = 4294967294;

function pragmaInt(db: DatabaseSync, name: string): number {
  return Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0]);
}

export class WriteCeiling {
  private readonly capped = new WeakMap<DatabaseSync, boolean>();
  private txSet = false;

  /** `growBytes`: null = no ceiling; undefined = keep the one already set. */
  apply(db: DatabaseSync, growBytes: number | null | undefined, useTx: boolean): void {
    if (growBytes === undefined || (useTx && this.txSet)) return;
    if (useTx) this.txSet = true;
    if (growBytes === null) {
      db.exec(`PRAGMA max_page_count=${NO_CEILING}`);
      this.capped.set(db, false);
      return;
    }
    const room = Math.floor(Math.max(0, growBytes) / pragmaInt(db, "page_size"));
    db.exec(`PRAGMA max_page_count=${pragmaInt(db, "page_count") + room}`);
    this.capped.set(db, true);
  }

  /** A transaction began or ended: its successor sets its own ceiling. */
  resetTx(): void {
    this.txSet = false;
  }

  /** SQLITE_FULL under a ceiling is the quota talking, not the disk. */
  translate(db: DatabaseSync, err: unknown): unknown {
    if (!this.capped.get(db) || !/database or disk is full/i.test((err as Error)?.message ?? "")) return err;
    return Object.assign(
      new Error(
        "This write would take your organization's databases past the space included in your plan, so it was " +
          "not applied. Nothing has been deleted and everything stays readable — free space by removing data you " +
          "no longer need, or contact Dilaya to raise the limit.",
      ),
      { code: "DB_QUOTA_EXCEEDED", status: 429 },
    );
  }
}
