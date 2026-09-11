export interface WriteStat {
  /** Epoch ms of the last statement that CHANGED this database; 0 = never. */
  lastWriteMs: number;
  /** Statements that changed it since this row was created. */
  writes: number;
  /**
   * Epoch ms of the last ACCESS of any kind — a read counts; 0 = never seen.
   *
   * A different question from `lastWriteMs`, and the two must never be
   * conflated: writes decide WHO is an eviction candidate, this decides who is
   * still in use and must be spared. Storing it here rather than in `AppSync`
   * is the whole point of `t_3bdea3eeebb6` — the in-memory mark did not
   * survive an instance replacement, so after every deploy the guard that
   * reads it was blind until each app was touched again.
   */
  lastTouchMs: number;
}

/** `<orgId>/<appId>` — the sort key, and the in-memory map key. */
export function statKey(orgId: string, appId: string): string {
  return `${orgId}/${appId}`;
}

/** What was last persisted for a key — the pair, because either half can move. */
export interface FlushedMark {
  lastWriteMs: number;
  lastTouchMs: number;
}

/** The persisted shape of one entry, for comparison. */
export function markOf(stat: WriteStat): FlushedMark {
  return { lastWriteMs: stat.lastWriteMs, lastTouchMs: stat.lastTouchMs };
}

/**
 * Which entries changed since the last flush.
 *
 * Pure, so the flush policy is testable without DynamoDB. Only apps that were
 * actually USED are flushed, so the write cost is proportional to real activity
 * rather than to the number of apps we host — which is the whole point of the
 * exercise.
 *
 * ⚠️ BOTH halves are compared. Comparing only `lastWriteMs` (which is what this
 * did before touches were persisted) would silently never flush an app that is
 * read and never written — precisely the app the touch mark exists for.
 */
export function pendingSince(
  stats: ReadonlyMap<string, WriteStat>,
  flushedAt: ReadonlyMap<string, FlushedMark>
): string[] {
  const out: string[] = [];
  for (const [key, stat] of stats) {
    const mark = flushedAt.get(key);
    if (
      mark === undefined ||
      mark.lastWriteMs !== stat.lastWriteMs ||
      mark.lastTouchMs !== stat.lastTouchMs
    ) {
      out.push(key);
    }
  }
  return out;
}
