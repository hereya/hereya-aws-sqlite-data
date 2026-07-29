// End-to-end proof over the real HTTP surface: the cap refuses a per-app
// Lambda's direct write — the path the connector cannot see — and nothing
// about reading, deleting or another org changes.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call, startTestService, type TestService } from "../helpers.ts";

let svc: TestService;
// Drives the usage-measurement cache; the last test jumps past its TTL rather
// than sleeping a real minute.
let clock = 0;

const A1 = { org_id: "org-a", app_id: "app-1" };
const A2 = { org_id: "org-a", app_id: "app-2" };
const B1 = { org_id: "org-b", app_id: "app-1" };

before(async () => {
  // org-a is capped at 1 MB and will blow through it; org-b is uncapped.
  svc = await startTestService({}, { quotaCaps: { "org-a": 1 }, quotaNow: () => clock });
  await call(svc.baseUrl, "/query", { ...A1, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, blob TEXT)" });
  await call(svc.baseUrl, "/query", { ...A2, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, blob TEXT)" });
  await call(svc.baseUrl, "/query", { ...B1, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, blob TEXT)" });
  // Pad app-1 well past the org's 1 MB cap. Deliberately more than SQLite's
  // auto-checkpoint threshold (~4 MB of WAL): usage is the MAIN file, so the
  // bytes only count once the WAL folds in — the under-count is bounded and
  // errs towards letting the customer write.
  for (let i = 0; i < 16; i += 1) {
    const res = await call(svc.baseUrl, "/query", {
      ...A1,
      sql: "INSERT INTO items (blob) VALUES (:b)",
      params: [{ name: "b", value: { stringValue: "x".repeat(400 * 1024) } }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  // Those inserts all fell inside one measurement window (the org measured
  // empty when the first one ran) — that bounded overshoot is by design. Step
  // past the window so the tests below see the org as it actually is now.
  clock += 120_001;
});

after(async () => {
  await svc.close();
});

test("the org is over its cap: a further write is refused with DB_QUOTA_EXCEEDED", async () => {
  const res = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "INSERT INTO items (blob) VALUES ('more')",
  });
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "DB_QUOTA_EXCEEDED");
  assert.match(res.body.error.message, /Nothing has been deleted/);
});

test("the cap is per ORG, not per app: a sibling app is refused too", async () => {
  const res = await call(svc.baseUrl, "/query", { ...A2, sql: "INSERT INTO items (blob) VALUES ('x')" });
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "DB_QUOTA_EXCEEDED");
});

test("everything stays readable", async () => {
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) AS n FROM items" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records[0][0].longValue, 16);
});

test("batch-execute is capped too (it is a write path)", async () => {
  const res = await call(svc.baseUrl, "/batch-execute", {
    ...A1,
    sql: "INSERT INTO items (blob) VALUES (:b)",
    parameterSets: [[{ name: "b", value: { stringValue: "a" } }]],
  });
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "DB_QUOTA_EXCEEDED");
});

test("another org is untouched", async () => {
  const res = await call(svc.baseUrl, "/query", { ...B1, sql: "INSERT INTO items (blob) VALUES ('fine')" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("an unknown pair is still a 403 — the cap never answers before authorization", async () => {
  const res = await call(svc.baseUrl, "/query", {
    org_id: "org-a",
    app_id: "app-nope",
    sql: "INSERT INTO items (blob) VALUES ('x')",
  });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "CROSS_ORG_DENIED");
});

test("the way out is never blocked: DELETE and VACUUM run even while over the cap", async () => {
  const del = await call(svc.baseUrl, "/query", { ...A1, sql: "DELETE FROM items" });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const vacuum = await call(svc.baseUrl, "/query", { ...A1, sql: "VACUUM" });
  assert.equal(vacuum.status, 200, JSON.stringify(vacuum.body));
});

test("emptying a table does not shrink the FILE, so the org stays capped — honestly", async () => {
  // Not a bug to paper over: those pages are still allocated to this org on
  // disk. SQLite reuses them for the next rows, and the file itself only
  // shrinks when the vacuumed image is checkpointed out of the WAL. The
  // customer's real remedies are the ones the refusal names — drop what they
  // no longer need, or have the cap raised.
  clock += 5_001;
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "INSERT INTO items (blob) VALUES ('early')" });
  assert.equal(res.status, 429, JSON.stringify(res.body));
});

test("reclaiming the space unblocks the org at the next refresh", async () => {
  // What dropping an unused app does, seen from the disk (the connector's
  // drop-app calls /admin/delete-app, which removes exactly these files).
  rmSync(join(svc.dbDir, "org-a", "app-1"), { recursive: true, force: true });

  // Still refused while the measurement is warm — the bounded, deliberate cost
  // of not re-walking the disk on every single write.
  const warm = await call(svc.baseUrl, "/query", { ...A2, sql: "INSERT INTO items (blob) VALUES ('early')" });
  assert.equal(warm.status, 429, JSON.stringify(warm.body));

  clock += 5_001; // an org at >=90% of its cap is re-measured every 5 seconds
  const res = await call(svc.baseUrl, "/query", { ...A2, sql: "INSERT INTO items (blob) VALUES ('back')" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});
