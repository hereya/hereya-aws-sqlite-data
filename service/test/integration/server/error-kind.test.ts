// `error.kind` over HTTP, through the real executor process, on every data
// route. It is ADDITIVE: the body is exactly { code, message } as before, plus
// kind — the fields a client already reads keep their value and their place.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { call, startTestService, type TestService } from "../../helpers.ts";

let svc: TestService;
before(async () => {
  svc = await startTestService();
  const setup = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "CREATE TABLE k (id INTEGER PRIMARY KEY, u TEXT UNIQUE, n TEXT NOT NULL)",
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
});
after(async () => {
  await svc.close();
});

const A1 = { org_id: "org-a", app_id: "app-1" };
const str = (name: string, v: string) => ({ name, value: { stringValue: v } });

function assertError(res: { status: number; body: any }, status: number, code: string, message: string, kind: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ["error"]);
  assert.deepEqual(Object.keys(res.body.error), ["code", "message", "kind"]);
  assert.deepEqual(res.body.error, { code, message, kind });
}

test("/query: SQLite's code and message unchanged, the kind beside them", async () => {
  const q = (sql: string) => call(svc.baseUrl, "/query", { ...A1, sql });
  assertError(await q("SELECT * FROM nope"), 400, "SQL_ERROR", "no such table: nope", "TABLE_NOT_FOUND");
  assertError(await q("SELECT zz FROM k"), 400, "SQL_ERROR", "no such column: zz", "COLUMN_NOT_FOUND");
  assertError(await q("SELEC 1"), 400, "SQL_ERROR", 'near "SELEC": syntax error', "SYNTAX");
  assertError(await q("CREATE TABLE k (x)"), 400, "SQL_ERROR", "table k already exists", "ALREADY_EXISTS");
  assertError(await q("INSERT INTO k (u) VALUES ('a')"), 400, "SQL_ERROR", "NOT NULL constraint failed: k.n", "NOT_NULL_VIOLATION");
  const forbidden = await q("ATTACH DATABASE 'x' AS y");
  assert.equal(forbidden.body.error.code, "SQL_FORBIDDEN");
  assert.equal(forbidden.body.error.kind, "FORBIDDEN_STATEMENT");
});

test("/batch-execute: a duplicate key in the second parameter set", async () => {
  const res = await call(svc.baseUrl, "/batch-execute", {
    ...A1,
    sql: "INSERT INTO k (u, n) VALUES (:u, :n)",
    parameterSets: [
      [str("u", "dup"), str("n", "one")],
      [str("u", "dup"), str("n", "two")],
    ],
  });
  assertError(res, 400, "SQL_ERROR", "UNIQUE constraint failed: k.u", "UNIQUE_VIOLATION");
});

test("/tx/*: a statement inside a transaction, and a refused transaction route", async () => {
  const begin = await call(svc.baseUrl, "/tx/begin", A1);
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const { transactionId } = begin.body;
  const inTx = await call(svc.baseUrl, "/query", { ...A1, transactionId, sql: "SELECT * FROM missing" });
  assertError(inTx, 400, "SQL_ERROR", "no such table: missing", "TABLE_NOT_FOUND");
  assert.equal((await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId })).status, 200);
  const gone = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId });
  assert.equal(gone.status, 409, JSON.stringify(gone.body));
  assert.equal(gone.body.error.code, "TX_NOT_FOUND");
  assert.equal(gone.body.error.kind, "OTHER");
});
