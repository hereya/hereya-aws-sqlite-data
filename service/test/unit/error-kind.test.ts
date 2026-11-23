// Every kind comes from a REAL SQLite error raised here (node:sqlite, the
// executor's own driver), or from the service refusal that owns it — and each
// SQLite case is checked twice: by its extended code, and by its message alone
// (the fallback for an error built without a code).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ERROR_KINDS, errorKind, sqliteErrorKind, type ErrorKind } from "../../src/error-kind.ts";
import { BUSY_MESSAGE } from "../../src/busy-timeout.ts";
import { ServiceError } from "../../src/errors.ts";
import { assertSafeSql } from "../../src/validate.ts";

const dir = mkdtempSync(join(tmpdir(), "error-kind-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const covered = new Set<ErrorKind>();

function schema(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE p(id INTEGER PRIMARY KEY);
    CREATE TABLE t(id INTEGER PRIMARY KEY, u TEXT UNIQUE, n TEXT NOT NULL, c INT CHECK (c > 0), p INT REFERENCES p(id));
    CREATE TABLE s(x INTEGER) STRICT;
    INSERT INTO t(id, u, n) VALUES (1, 'a', 'x');`);
}

function sqliteError(run: () => void): { errcode: number; message: string } {
  try {
    run();
  } catch (err) {
    const e = err as { errcode?: unknown; message: string };
    assert.equal(typeof e.errcode, "number", `no errcode on: ${e.message}`);
    return { errcode: e.errcode as number, message: e.message };
  }
  assert.fail("expected an error");
}

const mem = new DatabaseSync(":memory:");
schema(mem);

const CASES: Array<[string, ErrorKind, string]> = [
  ["SELECT * FROM nope", "TABLE_NOT_FOUND", "no such table: nope"],
  ["DROP TABLE nope", "TABLE_NOT_FOUND", "no such table: nope"],
  ["SELECT zz FROM t", "COLUMN_NOT_FOUND", "no such column: zz"],
  ["INSERT INTO t(nope) VALUES (1)", "COLUMN_NOT_FOUND", "table t has no column named nope"],
  ["INSERT INTO t(u, n) VALUES ('a', 'y')", "UNIQUE_VIOLATION", "UNIQUE constraint failed: t.u"],
  ["INSERT INTO t(id, n) VALUES (1, 'y')", "UNIQUE_VIOLATION", "UNIQUE constraint failed: t.id"],
  ["INSERT INTO t(n, p) VALUES ('y', 99)", "FOREIGN_KEY_VIOLATION", "FOREIGN KEY constraint failed"],
  ["INSERT INTO t(n) VALUES (NULL)", "NOT_NULL_VIOLATION", "NOT NULL constraint failed: t.n"],
  ["INSERT INTO t(n, c) VALUES ('y', -1)", "CHECK_VIOLATION", "CHECK constraint failed: c > 0"],
  ["CREATE TABLE t(x)", "ALREADY_EXISTS", "table t already exists"],
  ["CREATE INDEX t ON p(id)", "ALREADY_EXISTS", "there is already a table named t"],
  ["ALTER TABLE t ADD COLUMN n TEXT", "ALREADY_EXISTS", "duplicate column name: n"],
  ["SELEC 1", "SYNTAX", 'near "SELEC": syntax error'],
  ["SELECT 1 FROM t WHERE", "SYNTAX", "incomplete input"],
  ["SELECT 'a", "SYNTAX", "unrecognized token: \"'a\""],
  ["INSERT INTO s VALUES ('abc')", "TYPE_MISMATCH", "cannot store TEXT value in INTEGER column s.x"],
  ["INSERT INTO t(rowid, n) VALUES ('a', 'b')", "TYPE_MISMATCH", "datatype mismatch"],
  ["SELECT abs(1, 2)", "OTHER", "wrong number of arguments to function abs()"],
];

for (const [sql, kind, message] of CASES) {
  test(`${kind}: ${sql}`, () => {
    const e = sqliteError(() => mem.exec(sql));
    assert.equal(e.message, message);
    assert.equal(sqliteErrorKind(e.errcode, e.message), kind, "by code");
    assert.equal(sqliteErrorKind(undefined, e.message), kind, "by message alone");
    assert.equal(new ServiceError("SQL_ERROR", e.message, e.errcode).kind, kind);
    covered.add(kind);
  });
}

test("LOCKED: a second writer on a file whose lock is held (SQLITE_BUSY)", () => {
  const path = join(dir, "busy.db");
  const a = new DatabaseSync(path);
  const b = new DatabaseSync(path);
  a.exec("PRAGMA journal_mode=WAL; CREATE TABLE x(v); BEGIN IMMEDIATE");
  b.exec("PRAGMA busy_timeout=0");
  const e = sqliteError(() => b.exec("INSERT INTO x VALUES (1)"));
  a.exec("ROLLBACK");
  a.close();
  b.close();
  assert.equal(e.errcode & 0xff, 5);
  assert.equal(e.message, BUSY_MESSAGE);
  assert.equal(sqliteErrorKind(e.errcode, e.message), "LOCKED");
  // The parent's own answer to a write held past the busy timeout has no code.
  assert.equal(new ServiceError("SQL_ERROR", BUSY_MESSAGE).kind, "LOCKED");
  covered.add("LOCKED");
});

test("READ_ONLY: a write on a connection opened read-only (SQLITE_READONLY)", () => {
  const path = join(dir, "ro.db");
  new DatabaseSync(path).exec("CREATE TABLE x(v)");
  const ro = new DatabaseSync(path, { readOnly: true });
  const e = sqliteError(() => ro.exec("INSERT INTO x VALUES (1)"));
  ro.close();
  assert.equal(e.errcode & 0xff, 8);
  assert.match(e.message, /readonly database/);
  assert.equal(sqliteErrorKind(e.errcode, e.message), "READ_ONLY");
  assert.equal(sqliteErrorKind(undefined, e.message), "READ_ONLY");
  covered.add("READ_ONLY");
});

test("QUOTA_EXCEEDED, TIMEOUT, FORBIDDEN_STATEMENT come from the service's own refusals", () => {
  assert.equal(new ServiceError("DB_QUOTA_EXCEEDED", "over the plan").kind, "QUOTA_EXCEEDED");
  assert.equal(new ServiceError("QUERY_TIMEOUT", "query exceeded the 15000ms time limit").kind, "TIMEOUT");
  let forbidden: unknown;
  try {
    assertSafeSql("ATTACH DATABASE 'x' AS y");
  } catch (err) {
    forbidden = err;
  }
  assert.ok(forbidden instanceof ServiceError);
  assert.equal(forbidden.code, "SQL_FORBIDDEN");
  assert.equal(forbidden.kind, "FORBIDDEN_STATEMENT");
  for (const k of ["QUOTA_EXCEEDED", "TIMEOUT", "FORBIDDEN_STATEMENT"] as const) covered.add(k);
});

test("a refusal that is not a statement error is OTHER, whatever its message says", () => {
  assert.equal(errorKind("BAD_REQUEST", "no such table: x"), "OTHER");
  assert.equal(errorKind("THROTTLED", "too many in-flight requests"), "OTHER");
  assert.equal(errorKind("INTERNAL", "database is locked"), "OTHER");
  assert.equal(sqliteErrorKind(1, "something SQLite has not said before"), "OTHER");
});

test("the extended code wins over a message that would say otherwise", () => {
  assert.equal(sqliteErrorKind(2067, "no such table: x"), "UNIQUE_VIOLATION");
  assert.equal(sqliteErrorKind(517, "anything"), "LOCKED"); // SQLITE_BUSY_SNAPSHOT
});

test("every kind is produced by at least one case above", () => {
  covered.add("OTHER");
  assert.deepEqual([...covered].sort(), [...ERROR_KINDS].sort());
});
