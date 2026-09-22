// Quota policy — the pure arithmetic and SQL classification the cap is made of.
// No I/O, no AWS, no filesystem: every function here is a decision, not an effect.
import { stripSqlLiterals } from "../validate.ts";

export const MB = 1024 * 1024;

/** Human-readable size for a refusal message (the reader is not an engineer). */
export function humanBytes(bytes: number): string {
  const GB = 1024 * MB;
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes / GB >= 10 ? 0 : 1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes / MB >= 10 ? 0 : 1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/** At OR past the cap refuses: a 205 MB cap means 205 MB is the ceiling. */
export function overQuota(used: number, cap: number): boolean {
  return used >= cap;
}

/**
 * How long a measurement stays trusted — the window an org can overshoot by,
 * since the check reads a cached number.
 *
 * MUCH tighter than the connector's equivalent (30 min / 5 min / 1 min), and
 * deliberately: there, measuring means walking an org's S3 prefix, so a long
 * TTL buys real savings. Here it is a readdir plus two stat calls per app —
 * microseconds on a local disk. Paying that every two minutes to shrink the
 * overshoot from "half an hour of bulk inserts" to "two minutes of them" is an
 * obviously good trade, and the one thing that would make the cap useless is
 * letting an import blow past it while the number sits frozen.
 */
export function measureTtlMs(used: number, cap: number): number {
  if (cap <= 0) return 120_000;
  const ratio = used / cap;
  if (ratio >= 0.9) return 5_000;
  if (ratio >= 0.5) return 30_000;
  return 120_000;
}

// Statement heads the cap must not stand in the way of: reads, and the
// statements that FREE space. Mirrors the connector's list verbatim (VACUUM is
// what actually shrinks a SQLite file after a DELETE, so it has to pass too).
const QUOTA_EXEMPT_HEAD = /^\s*\(*\s*(SELECT|EXPLAIN|PRAGMA|DELETE|DROP|VACUUM|ANALYZE|REINDEX)\b/i;
// `WITH` is a read only when what follows the CTEs reads: `WITH c AS (…)
// INSERT …` used to ride this head straight past the cap (audit 22/09).
const CTE_HEAD = /^\s*\(*\s*WITH\b/i;
const CTE_WRITE = /\b(INSERT|UPDATE|REPLACE)\b/i;
// The `CREATE TABLE IF NOT EXISTS` every system table runs before reading it:
// a no-op when the table exists, and refusing it broke reads, deletes and
// Telegram ingress over the cap. `… AS SELECT` copies data — never exempt.
const IDEMPOTENT_DDL = /^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i;

/**
 * How far an EXEMPT statement may still grow the file: a DELETE runs its
 * triggers and a b-tree may need a page to rebalance, so "zero" would refuse
 * the very statements that free space — but a trigger planted under the cap
 * must not turn a DELETE into an unbounded write (the worker enforces it).
 */
export const EXEMPT_SLACK_BYTES = 256 * 1024;

function statementSkipsQuota(s: string): boolean {
  if (CTE_HEAD.test(s)) return !CTE_WRITE.test(s);
  if (IDEMPOTENT_DDL.test(s)) return !/\bSELECT\b/i.test(s);
  return QUOTA_EXEMPT_HEAD.test(s);
}

/**
 * Does this SQL bypass the cap? Every statement must qualify — a script mixing
 * a DELETE with an INSERT is a write, not a cleanup.
 */
export function sqlSkipsQuota(sql: string): boolean {
  const statements = stripSqlLiterals(sql)
    .split(";")
    .filter((s) => /\S/.test(s));
  if (statements.length === 0) return true; // nothing to run
  return statements.every(statementSkipsQuota);
}
