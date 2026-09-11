import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { call, startTestService, type TestService } from "../../helpers.ts";

let svc: TestService;

before(async () => {
  svc = await startTestService();
});

after(async () => {
  await svc.close();
});

const A1 = { org_id: "org-a", app_id: "app-1" };
const A2 = { org_id: "org-a", app_id: "app-2" };
const B1 = { org_id: "org-b", app_id: "app-1" };

test("typed round-trip: create, insert, select", async () => {
  const create = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty INTEGER, price REAL, active INTEGER, data BLOB, note TEXT)",
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));

  const insert = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "INSERT INTO items (name, qty, price, active, data, note) VALUES (:name, :qty, :price, :active, :data, :note)",
    params: [
      { name: "name", value: { stringValue: "widget" } },
      { name: "qty", value: { longValue: 5 } },
      { name: "price", value: { doubleValue: 9.75 } },
      { name: "active", value: { booleanValue: true } },
      { name: "data", value: { blobValue: Buffer.from("blobby").toString("base64") } },
      { name: "note", value: { isNull: true } },
    ],
  });
  assert.equal(insert.status, 200, JSON.stringify(insert.body));
  assert.equal(insert.body.numberOfRecordsUpdated, 1);
  assert.equal(insert.body.lastInsertId, 1);

  const select = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT id, name, qty, price, active, data, note FROM items",
  });
  assert.equal(select.status, 200);
  assert.deepEqual(
    select.body.columnMetadata.map((c: { name: string }) => c.name),
    ["id", "name", "qty", "price", "active", "data", "note"],
  );
  const row = select.body.records[0];
  assert.deepEqual(row[0], { longValue: 1 });
  assert.deepEqual(row[1], { stringValue: "widget" });
  assert.deepEqual(row[2], { longValue: 5 });
  assert.deepEqual(row[3], { doubleValue: 9.75 });
  assert.deepEqual(row[4], { longValue: 1 }); // booleans are INTEGER 0/1 in SQLite
  assert.deepEqual(row[5], { blobValue: Buffer.from("blobby").toString("base64") });
  assert.deepEqual(row[6], { isNull: true });
});

test("update reports numberOfRecordsUpdated", async () => {
  const res = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "UPDATE items SET qty = qty + 1 WHERE name = :n",
    params: [{ name: "n", value: { stringValue: "widget" } }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.numberOfRecordsUpdated, 1);
});

test("apps are isolated: same table name, different files", async () => {
  await call(svc.baseUrl, "/query", { ...B1, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, secret TEXT)" });
  await call(svc.baseUrl, "/query", {
    ...B1,
    sql: "INSERT INTO items (secret) VALUES ('org-b-only')",
  });
  const fromA = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT name FROM items" });
  assert.equal(fromA.status, 200);
  assert.deepEqual(fromA.body.records[0][0], { stringValue: "widget" });
  const fromB = await call(svc.baseUrl, "/query", { ...B1, sql: "SELECT secret FROM items" });
  assert.deepEqual(fromB.body.records[0][0], { stringValue: "org-b-only" });
});

test("ATTACH and write-PRAGMA are rejected", async () => {
  const attach = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "ATTACH DATABASE '/var/lib/dilaya/dbs/org-b/app-1/app.db' AS other",
  });
  assert.equal(attach.status, 400);
  assert.equal(attach.body.error.code, "SQL_FORBIDDEN");

  const pragma = await call(svc.baseUrl, "/query", { ...A1, sql: "PRAGMA journal_mode=DELETE" });
  assert.equal(pragma.status, 400);
  assert.equal(pragma.body.error.code, "SQL_FORBIDDEN");

  const readPragma = await call(svc.baseUrl, "/query", { ...A1, sql: "PRAGMA table_info(items)" });
  assert.equal(readPragma.status, 200);
  assert.ok(readPragma.body.records.length > 0);
});

test("transactions: commit persists, rollback discards, ids are pair-scoped", async () => {
  const begin = await call(svc.baseUrl, "/tx/begin", A1);
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const txId = begin.body.transactionId;
  assert.ok(txId);

  const ins = await call(svc.baseUrl, "/query", {
    ...A1,
    transactionId: txId,
    sql: "INSERT INTO items (name, qty) VALUES ('tx-item', 1)",
  });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));

  // a foreign pair cannot use this transaction id
  const foreign = await call(svc.baseUrl, "/query", {
    ...B1,
    transactionId: txId,
    sql: "SELECT 1",
  });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.error.code, "TX_NOT_FOUND");

  // uncommitted data is invisible to autocommit readers (separate connection)
  const dirty = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT COUNT(*) AS c FROM items WHERE name = 'tx-item'",
  });
  assert.deepEqual(dirty.body.records[0][0], { longValue: 0 });

  const commit = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId: txId });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.status, "committed");

  const after = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT COUNT(*) AS c FROM items WHERE name = 'tx-item'",
  });
  assert.deepEqual(after.body.records[0][0], { longValue: 1 });

  // rollback path
  const begin2 = await call(svc.baseUrl, "/tx/begin", A1);
  const tx2 = begin2.body.transactionId;
  await call(svc.baseUrl, "/query", {
    ...A1,
    transactionId: tx2,
    sql: "INSERT INTO items (name, qty) VALUES ('doomed', 1)",
  });
  const rb = await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId: tx2 });
  assert.equal(rb.status, 200);
  const gone = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT COUNT(*) AS c FROM items WHERE name = 'doomed'",
  });
  assert.deepEqual(gone.body.records[0][0], { longValue: 0 });

  // commit of unknown tx → 409; rollback of unknown tx → idempotent 200
  const badCommit = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId: tx2 });
  assert.equal(badCommit.status, 409);
  const idemRb = await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId: tx2 });
  assert.equal(idemRb.status, 200);
});

test("batch-execute inserts every parameter set", async () => {
  await call(svc.baseUrl, "/query", { ...A2, sql: "CREATE TABLE batch (a TEXT, b INTEGER)" });
  const res = await call(svc.baseUrl, "/batch-execute", {
    ...A2,
    sql: "INSERT INTO batch (a, b) VALUES (:a, :b)",
    parameterSets: [
      [
        { name: "a", value: { stringValue: "one" } },
        { name: "b", value: { longValue: 1 } },
      ],
      [
        { name: "a", value: { stringValue: "two" } },
        { name: "b", value: { longValue: 2 } },
      ],
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updateResults.length, 2);
  const count = await call(svc.baseUrl, "/query", { ...A2, sql: "SELECT COUNT(*) AS c FROM batch" });
  assert.deepEqual(count.body.records[0][0], { longValue: 2 });
});

test("query timeout kills only the offending app's in-flight work", async () => {
  const bombPromise = call(svc.baseUrl, "/query", {
    ...A1,
    sql: "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT MAX(x) FROM r",
  });
  // while the bomb runs on app-1, app-2 stays responsive
  const other = await call(svc.baseUrl, "/query", { ...A2, sql: "SELECT COUNT(*) AS c FROM batch" });
  assert.equal(other.status, 200);

  const bomb = await bombPromise;
  assert.equal(bomb.status, 408, JSON.stringify(bomb.body));
  assert.equal(bomb.body.error.code, "QUERY_TIMEOUT");

  // the app recovers on a fresh worker
  const recovered = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) AS c FROM items" });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
});
