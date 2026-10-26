// The migration fence (fence.ts): what counts as a write, and how the freeze is
// read off the org row — same GetItem as the quota, a much shorter TTL, fail
// open but sticky on an unreadable row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import { ORG_MIGRATING_MESSAGE, OrgFence, sqlMutates } from "../../src/fence.ts";
import { DdbOrgQuotaReader } from "../../src/quota.ts";

test("reads do not mutate", () => {
  for (const sql of [
    "SELECT * FROM items",
    "  with x as (select 1) select * from x",
    "EXPLAIN QUERY PLAN SELECT 1",
    "PRAGMA table_info(items)",
    "(SELECT 1)",
    "SELECT 1; SELECT 2;",
    "SELECT * FROM t WHERE note = 'DELETE everything'",
    "CREATE TABLE IF NOT EXISTS _sys (k TEXT)",
  ]) {
    assert.equal(sqlMutates(sql), false, sql);
  }
});

test("every statement that changes the file mutates — DELETE/DROP/VACUUM included", () => {
  for (const sql of [
    "INSERT INTO items (a) VALUES (1)",
    "UPDATE items SET a = 1",
    "REPLACE INTO items (a) VALUES (1)",
    "DELETE FROM items WHERE id < 100",
    "DROP TABLE items",
    "VACUUM",
    "ANALYZE",
    "REINDEX",
    "CREATE TABLE t (a)",
    "CREATE TABLE IF NOT EXISTS t AS SELECT * FROM items",
    "ALTER TABLE items ADD COLUMN b",
    "WITH old AS (SELECT id FROM items) DELETE FROM items WHERE id IN (SELECT id FROM old)",
    "with c as (select 1) insert into items select * from c",
    "SELECT 1; DELETE FROM items",
    "/* comment */ DELETE FROM items",
  ]) {
    assert.equal(sqlMutates(sql), true, sql);
  }
});

test("a frozen org's write is refused with 503 ORG_MIGRATING + Retry-After; its reads and other orgs pass", async () => {
  const fence = new OrgFence({ migrationFrozen: async (org) => org === "org-a" });
  await assert.rejects(
    () => fence.assertWritable("org-a", true),
    (err: unknown) =>
      err instanceof ServiceError &&
      err.code === "ORG_MIGRATING" &&
      err.status === 503 &&
      err.retryAfterS === 120 &&
      err.message === ORG_MIGRATING_MESSAGE,
  );
  await fence.assertWritable("org-a", false);
  await fence.assertWritable("org-b", true);
});

test("a read never pays the registry read", async () => {
  let reads = 0;
  const fence = new OrgFence({ migrationFrozen: async () => (reads++, true) });
  await fence.assertWritable("org-a", false);
  assert.equal(reads, 0);
});

/** A DynamoDB stand-in for the org row; `fail` makes the next send throw. */
function fakeDdb(item: () => Record<string, unknown> | undefined) {
  const state = { calls: 0, fail: false, inputs: [] as any[] };
  const client = {
    send: async (cmd: { input: unknown }) => {
      state.calls += 1;
      state.inputs.push(cmd.input);
      if (state.fail) throw new Error("ProvisionedThroughputExceeded");
      return { Item: item() };
    },
  };
  return { state, client: client as never };
}

test("the reader: one consistent GetItem for cap AND freeze, freeze trusted 2 s, cap 30 s", async () => {
  let now = 0;
  let row: Record<string, unknown> | undefined = { maxDbMb: { N: "205" } };
  const ddb = fakeDdb(() => row);
  const r = new DdbOrgQuotaReader({ tableName: "t", region: "eu-west-1", cacheMs: 30_000, client: ddb.client, now: () => now });
  assert.equal(await r.migrationFrozen("org-a"), false);
  assert.equal(await r.maxDbMb("org-a"), 205, "the cap rides the same read");
  assert.equal(ddb.state.calls, 1);
  assert.equal(ddb.state.inputs[0].ConsistentRead, true);

  row = { maxDbMb: { N: "205" }, migrationFreeze: { M: { since: { S: "2026-10-26T10:00:00Z" } } } };
  now += 1_999;
  assert.equal(await r.migrationFrozen("org-a"), false, "still inside the 2 s window");
  now += 1;
  assert.equal(await r.migrationFrozen("org-a"), true, "the freeze bites at 2 s");
  assert.equal(ddb.state.calls, 2);

  row = { migrationFreeze: { NULL: true } };
  now += 2_000;
  assert.equal(await r.migrationFrozen("org-a"), true, "ANY value present = frozen");
  row = { maxDbMb: { N: "205" } };
  now += 2_000;
  assert.equal(await r.migrationFrozen("org-a"), false, "unfreeze is seen as fast");
});

test("unreadable row: fail open when never seen, STICKY when last seen frozen; not cached", async () => {
  let now = 0;
  const ddb = fakeDdb(() => ({ migrationFreeze: { S: "x" }, maxDbMb: { N: "10" } }));
  const r = new DdbOrgQuotaReader({ tableName: "t", region: "eu-west-1", cacheMs: 30_000, client: ddb.client, now: () => now });
  ddb.state.fail = true;
  assert.equal(await r.migrationFrozen("org-a"), false, "never read: fail open, like the quota");
  assert.equal(await r.maxDbMb("org-a"), null);

  ddb.state.fail = false;
  assert.equal(await r.migrationFrozen("org-a"), true);
  ddb.state.fail = true;
  now += 60_000;
  assert.equal(await r.migrationFrozen("org-a"), true, "a blip does not lift a freeze this VM saw");
  assert.equal(await r.maxDbMb("org-a"), null, "the quota keeps its historical fail-open");
  const before = ddb.state.calls;
  await r.migrationFrozen("org-a");
  assert.equal(ddb.state.calls, before + 1, "a failure is not cached: the next call retries");
});

test("a burst after expiry shares ONE GetItem", async () => {
  const ddb = fakeDdb(() => ({}));
  const r = new DdbOrgQuotaReader({ tableName: "t", region: "eu-west-1", cacheMs: 30_000, client: ddb.client });
  await Promise.all(Array.from({ length: 20 }, () => r.migrationFrozen("org-a")));
  assert.equal(ddb.state.calls, 1);
});
