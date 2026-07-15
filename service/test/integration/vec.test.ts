// sqlite-vec (vec0): the extension is preloaded on every app connection, so
// tenant SQL can create vec0 virtual tables and run KNN — while load_extension
// itself stays unavailable to tenant SQL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { assertVecLoadable } from "../../src/vec.ts";
import { call, startTestService, type TestService } from "../helpers.ts";

let svc: TestService;

before(async () => {
  svc = await startTestService();
});

after(async () => {
  await svc.close();
});

const A1 = { org_id: "org-a", app_id: "app-1" };

test("assertVecLoadable returns the pinned vec version", () => {
  const version = assertVecLoadable();
  // vec_version() reports with the v prefix, matching the release tag
  const pinned = readFileSync(join(import.meta.dirname, "../../../scripts/sqlite-vec-version.txt"), "utf8").trim();
  assert.equal(version, pinned);
});

test("vec0 round-trip: create virtual table, insert, KNN", async () => {
  const create = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4])",
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));

  for (const [rowid, vec] of [
    [1, "[1, 0, 0, 0]"],
    [2, "[0, 1, 0, 0]"],
    [3, "[0.9, 0.1, 0, 0]"],
  ] as const) {
    const insert = await call(svc.baseUrl, "/query", {
      ...A1,
      sql: "INSERT INTO vec_items (rowid, embedding) VALUES (:id, :v)",
      params: [
        { name: "id", value: { longValue: rowid } },
        { name: "v", value: { stringValue: vec } },
      ],
    });
    assert.equal(insert.status, 200, JSON.stringify(insert.body));
  }

  const knn = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT rowid, distance FROM vec_items WHERE embedding MATCH :q ORDER BY distance LIMIT 2",
    params: [{ name: "q", value: { stringValue: "[1, 0, 0, 0]" } }],
  });
  assert.equal(knn.status, 200, JSON.stringify(knn.body));
  const ids = knn.body.records.map((r: Array<{ longValue?: number }>) => r[0]!.longValue);
  assert.deepEqual(ids, [1, 3]); // exact match first, then the near neighbor
  assert.equal(knn.body.records[0][1].doubleValue, 0);
});

test("vec0 data survives a service restart on the same db dir (restore/read path)", async () => {
  const second = await startTestService({ dbDir: svc.dbDir });
  try {
    const knn = await call(second.baseUrl, "/query", {
      ...A1,
      sql: "SELECT rowid FROM vec_items WHERE embedding MATCH :q ORDER BY distance LIMIT 1",
      params: [{ name: "q", value: { stringValue: "[0, 1, 0, 0]" } }],
    });
    assert.equal(knn.status, 200, JSON.stringify(knn.body));
    assert.equal(knn.body.records[0][0].longValue, 2);
  } finally {
    await second.close();
  }
});

test("load_extension stays unavailable to tenant SQL", async () => {
  const res = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT load_extension('vec0')",
  });
  assert.notEqual(res.status, 200);
  assert.equal(res.body.error.code, "SQL_ERROR");
});
