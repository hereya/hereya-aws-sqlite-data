// An engine-neutral name for what went wrong, sent as `error.kind` next to
// `error.code` and `error.message` (additive: neither of those changes). A
// caller that needs to tell "no such table" from "duplicate key" reads this
// instead of matching the engine's own wording, which stays in `message`.
//
// SQLite's extended result code decides when the executor has one; the message
// is the fallback (an error built without a code, e.g. the parent's own "database
// is locked" for a write held past the busy timeout) and the tie-breaker for the
// generic SQLITE_ERROR, which covers missing tables, syntax and more alike.
import type { ErrorCode } from "./errors.ts";

export const ERROR_KINDS = [
  "TABLE_NOT_FOUND",
  "COLUMN_NOT_FOUND",
  "UNIQUE_VIOLATION",
  "FOREIGN_KEY_VIOLATION",
  "NOT_NULL_VIOLATION",
  "CHECK_VIOLATION",
  "ALREADY_EXISTS",
  "SYNTAX",
  "LOCKED",
  "READ_ONLY",
  "QUOTA_EXCEEDED",
  "TIMEOUT",
  "FORBIDDEN_STATEMENT",
  "TYPE_MISMATCH",
  "OTHER",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

// SQLite extended result codes (sqlite3.h), exact match first.
const BY_EXTENDED: Record<number, ErrorKind> = {
  275: "CHECK_VIOLATION", // SQLITE_CONSTRAINT_CHECK
  787: "FOREIGN_KEY_VIOLATION", // SQLITE_CONSTRAINT_FOREIGNKEY
  1299: "NOT_NULL_VIOLATION", // SQLITE_CONSTRAINT_NOTNULL
  1555: "UNIQUE_VIOLATION", // SQLITE_CONSTRAINT_PRIMARYKEY
  2067: "UNIQUE_VIOLATION", // SQLITE_CONSTRAINT_UNIQUE
  2579: "UNIQUE_VIOLATION", // SQLITE_CONSTRAINT_ROWID
  3091: "TYPE_MISMATCH", // SQLITE_CONSTRAINT_DATATYPE (STRICT tables)
};

// Primary result codes (the low byte of any extended code).
const BY_PRIMARY: Record<number, ErrorKind> = {
  5: "LOCKED", // SQLITE_BUSY (and its BUSY_* extensions)
  6: "LOCKED", // SQLITE_LOCKED
  8: "READ_ONLY", // SQLITE_READONLY
  20: "TYPE_MISMATCH", // SQLITE_MISMATCH
};

// In order: the first match wins.
const BY_MESSAGE: ReadonlyArray<readonly [RegExp, ErrorKind]> = [
  [/\bno such table\b/i, "TABLE_NOT_FOUND"],
  [/\bno such column\b|\bhas no column named\b/i, "COLUMN_NOT_FOUND"],
  [/\bUNIQUE constraint failed\b|\bPRIMARY KEY must be unique\b/i, "UNIQUE_VIOLATION"],
  [/\bFOREIGN KEY constraint failed\b/i, "FOREIGN_KEY_VIOLATION"],
  [/\bNOT NULL constraint failed\b/i, "NOT_NULL_VIOLATION"],
  [/\bCHECK constraint failed\b/i, "CHECK_VIOLATION"],
  [/\bcannot store \w+ value in \w+ column\b|\bdatatype mismatch\b/i, "TYPE_MISMATCH"],
  [/\balready exists\b|\bthere is already an? \w+ named\b|\bduplicate column name\b/i, "ALREADY_EXISTS"],
  [/\bsyntax error\b|^incomplete input$|\bunrecognized token\b/i, "SYNTAX"],
  [/\bdatabase is locked\b|\bdatabase table is locked\b/i, "LOCKED"],
  [/\breadonly database\b/i, "READ_ONLY"],
];

/** The kind of a statement error, from SQLite's extended code when known. */
export function sqliteErrorKind(sqliteCode: number | undefined, message: string): ErrorKind {
  if (typeof sqliteCode === "number") {
    const exact = BY_EXTENDED[sqliteCode] ?? BY_PRIMARY[sqliteCode & 0xff];
    if (exact) return exact;
  }
  for (const [pattern, kind] of BY_MESSAGE) if (pattern.test(message)) return kind;
  return "OTHER";
}

/** The kind of any service error: the service's own refusals by their code. */
export function errorKind(code: ErrorCode, message: string, sqliteCode?: number): ErrorKind {
  switch (code) {
    case "SQL_ERROR":
      return sqliteErrorKind(sqliteCode, message);
    case "DB_QUOTA_EXCEEDED":
      return "QUOTA_EXCEEDED";
    case "QUERY_TIMEOUT":
      return "TIMEOUT";
    case "SQL_FORBIDDEN":
      return "FORBIDDEN_STATEMENT";
    default:
      return "OTHER";
  }
}
