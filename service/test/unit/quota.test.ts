import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import {
  DbQuotaGuard,
  MB,
  StaticOrgQuotaReader,
  humanBytes,
  measureOrgDbBytes,
  measureTtlMs,
  overQuota,
  sqlSkipsQuota,
  type OrgQuotaReader,
} from "../../src/quota.ts";

const isQuotaError = (err: unknown): err is ServiceError =>
  err instanceof ServiceError && err.code === "DB_QUOTA_EXCEEDED" && err.status === 429;

test("reads and space-freeing statements are never capped", () => {
  for (const sql of [
    "SELECT * FROM items",
    "  with x as (select 1) select * from x",
    "EXPLAIN QUERY PLAN SELECT 1",
    "PRAGMA table_info(items)",
    "DELETE FROM items WHERE id < 100",
    "DROP TABLE items",
    "VACUUM",
    "(SELECT 1)",
  ]) {
    assert.equal(sqlSkipsQuota(sql), true, sql);
  }
});

test("writes are capped", () => {
  for (const sql of [
    "INSERT INTO items (a) VALUES (1)",
    "UPDATE items SET a = 1",
    "CREATE TABLE t (a)",
    "ALTER TABLE t ADD COLUMN b",
    "REPLACE INTO items VALUES (1)",
  ]) {
    assert.equal(sqlSkipsQuota(sql), false, sql);
  }
});

test("a script is exempt only when EVERY statement is — no DELETE-then-INSERT bypass", () => {
  assert.equal(sqlSkipsQuota("DELETE FROM a; DELETE FROM b;"), true);
  assert.equal(sqlSkipsQuota("SELECT 1; PRAGMA table_info(t);"), true);
  assert.equal(sqlSkipsQuota("DELETE FROM a; INSERT INTO b VALUES (1)"), false);
  assert.equal(sqlSkipsQuota("SELECT 1; UPDATE t SET a = 1"), false);
});

test("a semicolon inside a string literal does not split a statement", () => {
  // stripSqlLiterals blanks the literal, so this stays ONE insert (capped).
  assert.equal(sqlSkipsQuota("INSERT INTO t (s) VALUES ('a; DELETE FROM x')"), false);
  // ...and a read carrying one stays a read.
  assert.equal(sqlSkipsQuota("SELECT 'a; b' FROM t"), true);
});

test("the cap is a ceiling: at the cap already refuses", () => {
  assert.equal(overQuota(204 * MB, 205 * MB), false);
  assert.equal(overQuota(205 * MB, 205 * MB), true);
  assert.equal(overQuota(206 * MB, 205 * MB), true);
});

test("measurement is re-checked more often as the org nears its cap", () => {
  const cap = 100 * MB;
  assert.equal(measureTtlMs(10 * MB, cap), 120_000);
  assert.equal(measureTtlMs(60 * MB, cap), 30_000);
  assert.equal(measureTtlMs(95 * MB, cap), 5_000);
});

test("the overshoot window stays short even for an org starting from empty", () => {
  // The regression that matters: a generous TTL at low usage lets a bulk
  // import blow straight past the cap while the cached number sits at zero.
  assert.ok(measureTtlMs(0, 205 * MB) <= 120_000);
});

test("humanBytes speaks to a person, not to a machine", () => {
  assert.equal(humanBytes(205 * MB), "205 MB");
  assert.equal(humanBytes(1024 * MB), "1.0 GB");
  assert.equal(humanBytes(2048), "2 KB");
});

test("measureOrgDbBytes sums every app db of the org — and never the WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-measure-"));
  const write = (org: string, app: string, name: string, bytes: number) => {
    mkdirSync(join(dir, org, app), { recursive: true });
    writeFileSync(join(dir, org, app, name), Buffer.alloc(bytes));
  };
  write("org-a", "app-1", "app.db", 1000);
  // Counting this would make VACUUM — which rewrites the db through the WAL —
  // look like the org just doubled in size, right when it is freeing space.
  write("org-a", "app-1", "app.db-wal", 500_000);
  write("org-a", "app-2", "app.db", 300);
  write("org-a", "app-2", "stray.txt", 9999); // not a db file: ignored
  write("org-b", "app-1", "app.db", 7777); // another org: never counted

  assert.equal(measureOrgDbBytes(dir, "org-a"), 1300);
  assert.equal(measureOrgDbBytes(dir, "org-b"), 7777);
  assert.equal(measureOrgDbBytes(dir, "org-unknown"), 0);
});

function guard(opts: {
  caps: Record<string, number | null>;
  bytes: number | (() => number);
  now?: () => number;
}): { guard: DbQuotaGuard; measurements: () => number } {
  let measurements = 0;
  const g = new DbQuotaGuard({
    dbDir: "/nowhere",
    reader: new StaticOrgQuotaReader(opts.caps),
    now: opts.now,
    measure: () => {
      measurements += 1;
      return typeof opts.bytes === "function" ? opts.bytes() : opts.bytes;
    },
  });
  return { guard: g, measurements: () => measurements };
}

test("an over-cap org is refused a write but keeps reading and freeing space", async () => {
  const { guard: g } = guard({ caps: { "org-a": 205 }, bytes: 700 * MB });

  await assert.rejects(() => g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (1)"), isQuotaError);
  await assert.rejects(() => g.assertWriteAllowed("org-a", "CREATE TABLE t (a)"), isQuotaError);

  // the way out is never blocked
  await g.assertWriteAllowed("org-a", "SELECT * FROM t");
  await g.assertWriteAllowed("org-a", "DELETE FROM t");
  await g.assertWriteAllowed("org-a", "VACUUM");
});

test("the refusal says what happened and what to do, in bytes a human reads", async () => {
  const { guard: g } = guard({ caps: { "org-a": 205 }, bytes: 700 * MB });
  await assert.rejects(
    () => g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (1)"),
    (err: unknown) => {
      assert.ok(isQuotaError(err));
      assert.match(err.message, /700 MB/);
      assert.match(err.message, /205 MB/);
      assert.match(err.message, /Nothing has been deleted/);
      return true;
    },
  );
});

test("an org under its cap writes freely", async () => {
  const { guard: g } = guard({ caps: { "org-a": 1024 }, bytes: 8 * MB });
  await g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (1)");
});

test("an uncapped org costs nothing: no filesystem walk at all", async () => {
  const { guard: g, measurements } = guard({ caps: { "org-a": null }, bytes: 999 * MB });
  await g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (1)");
  await g.assertWriteAllowed("org-unknown", "INSERT INTO t VALUES (1)");
  assert.equal(measurements(), 0);
});

test("an unreadable cap fails OPEN — a blinking registry never blocks writes", async () => {
  const broken: OrgQuotaReader = {
    async maxDbMb() {
      return null; // DdbOrgQuotaReader swallows its errors into exactly this
    },
  };
  const g = new DbQuotaGuard({
    dbDir: "/nowhere",
    reader: broken,
    measure: () => 999 * MB,
  });
  await g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (1)");
});

test("usage is measured once per TTL, and freeing space unblocks at the next refresh", async () => {
  let now = 0;
  let bytes = 700 * MB;
  const { guard: g, measurements } = guard({
    caps: { "org-a": 205 },
    bytes: () => bytes,
    now: () => now,
  });

  await assert.rejects(() => g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (1)"), isQuotaError);
  await assert.rejects(() => g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (2)"), isQuotaError);
  assert.equal(measurements(), 1, "the second write reuses the cached measurement");

  // The customer deletes data, but the measurement is still warm (5s TTL at
  // >=90% of the cap) — one more refusal is the bounded cost of caching.
  bytes = 10 * MB;
  await assert.rejects(() => g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (3)"), isQuotaError);

  now += 5_001;
  await g.assertWriteAllowed("org-a", "INSERT INTO t VALUES (4)");
  assert.equal(measurements(), 2);
});
