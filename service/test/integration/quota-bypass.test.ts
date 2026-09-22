// The holes the 22/09 quota audit found in the VM-side cap (t_quota_db_bypass),
// each proven over the real HTTP surface with a real worker:
//   * `WITH … INSERT` rode the exempt `WITH` head straight past the cap;
//   * an exempt DELETE could write through a trigger planted under the cap;
//   * nothing bounded ONE statement — a single INSERT…SELECT randomblob()
//     issued under the cap could write gigabytes;
//   * the idempotent `CREATE TABLE IF NOT EXISTS` every system table runs was
//     refused over the cap, breaking reads, deletes and Telegram ingress.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { call, startTestService, type TestService } from "../helpers.ts";

let svc: TestService;
let clock = 0;

const C1 = { org_id: "org-a", app_id: "app-1" };
const D1 = { org_id: "org-b", app_id: "app-1" };

const q = (target: object, sql: string) => call(svc.baseUrl, "/query", { ...target, sql });

before(async () => {
  // org-a is capped at 1 MB; org-b at 2 MB and stays under it.
  svc = await startTestService({}, { quotaCaps: { "org-a": 1, "org-b": 2 }, quotaNow: () => clock });
  for (const t of [C1, D1]) {
    assert.equal((await q(t, "CREATE TABLE big (b BLOB)")).status, 200);
    assert.equal((await q(t, "CREATE TABLE a (x INTEGER)")).status, 200);
  }
  // Planted while org-a is still under its cap: every deleted row of `a`
  // writes 200 KB into `big`.
  const trig = await q(C1, "CREATE TRIGGER grow AFTER DELETE ON a BEGIN INSERT INTO big VALUES (randomblob(204800)); END");
  assert.equal(trig.status, 200, JSON.stringify(trig.body));
  assert.equal((await q(C1, "INSERT INTO a (x) VALUES (1),(2),(3),(4),(5),(6),(7),(8)")).status, 200);
  // Now push org-a past its cap with ordinary, individually small writes — past
  // the ~4 MB auto-checkpoint too, since the VM counts the MAIN file only.
  for (let i = 0; i < 16; i += 1) {
    assert.equal((await q(C1, "INSERT INTO big VALUES (randomblob(307200))")).status, 200);
  }
  clock += 120_001; // step past the measurement window: org-a now measures over
});

after(async () => {
  await svc.close();
});

test("ONE statement cannot write past the org's remaining room, even under the cap", async () => {
  const res = await q(D1, "INSERT INTO big SELECT randomblob(3145728)");
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "DB_QUOTA_EXCEEDED");
  // …and a write that fits still goes through.
  assert.equal((await q(D1, "INSERT INTO big SELECT randomblob(1024)")).status, 200);
});

test("`WITH … INSERT` is a write, not a read", async () => {
  // Sanity: the org really is over its cap for a plain write.
  assert.equal((await q(C1, "INSERT INTO big VALUES (x'01')")).status, 429);
  const res = await q(C1, "WITH c AS (SELECT 1) INSERT INTO big SELECT randomblob(10) FROM c");
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "DB_QUOTA_EXCEEDED");
});

test("an exempt DELETE cannot grow the database through a trigger", async () => {
  const res = await q(C1, "DELETE FROM a");
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "DB_QUOTA_EXCEEDED");
});

test("over the cap, a DELETE that frees space still passes", async () => {
  assert.equal((await q(C1, "DROP TRIGGER grow")).status, 200);
  const res = await q(C1, "DELETE FROM big WHERE rowid = 1");
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("over the cap, the idempotent `CREATE TABLE IF NOT EXISTS` of a system table passes", async () => {
  const res = await q(C1, "CREATE TABLE IF NOT EXISTS big (b BLOB)");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // A CTE that only reads stays a read.
  assert.equal((await q(C1, "WITH c AS (SELECT 1) SELECT * FROM c")).status, 200);
});
