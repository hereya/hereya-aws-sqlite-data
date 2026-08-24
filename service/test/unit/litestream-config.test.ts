// Generated litestream.yml must use the 0.5.x schema. This is load-bearing:
// 0.5.x config parsing is NON-STRICT — the legacy replica-level `retention:`
// and `snapshot-interval:` keys are silently ignored, which would shrink the
// restore window to the 24h defaults without any error. Snapshots moved to a
// global `snapshot: {interval, retention}` block and each db takes a single
// `replica:` (the `replicas:` array is deprecated).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.ts";
import { Litestream } from "../../src/litestream.ts";

const litestreamBin = fileURLToPath(new URL("../../../.toolchain/litestream", import.meta.url));
const haveLitestream = existsSync(litestreamBin);

function makeLitestream(extra: Record<string, string> = {}): Litestream {
  return new Litestream(
    loadConfig({
      REPLICA_BASE_URL: "file:///replicas",
      LITESTREAM_SYNC_INTERVAL_MS: "1000",
      LITESTREAM_RETENTION: "72h",
      LITESTREAM_SNAPSHOT_INTERVAL: "6h",
      ...extra,
    } as NodeJS.ProcessEnv),
  );
}

const APPS = [
  { orgId: "org-a", appId: "app-1", dbPath: "/dbs/org-a/app-1/app.db" },
  { orgId: "org-b", appId: "app-2", dbPath: "/dbs/org-b/app-2/app.db" },
];

test("buildConfig emits the 0.5.x schema (global snapshot, single replica)", () => {
  const yml = makeLitestream().buildConfig(APPS);
  assert.equal(
    yml,
    [
      // The shipped cadence (chosen 2026-08-24). NOT litestream's defaults —
      // those are 15s/30s/5m/1h and billed 1.343 USD per app per month.
      "l0-retention: 3h",
      "l0-retention-check-interval: 30m",
      "levels:",
      "  - interval: 30m",
      "  - interval: 2h",
      "  - interval: 6h",
      "snapshot:",
      "  interval: 6h",
      "  retention: 72h",
      "dbs:",
      "  - path: /dbs/org-a/app-1/app.db",
      "    replica:",
      "      url: file:///replicas/org-a/app-1/app.db",
      "      sync-interval: 1000ms",
      "  - path: /dbs/org-b/app-2/app.db",
      "    replica:",
      "      url: file:///replicas/org-b/app-2/app.db",
      "      sync-interval: 1000ms",
      "",
    ].join("\n"),
  );
});

test("buildConfig never emits the silently-ignored 0.3.x replica keys", () => {
  const yml = makeLitestream().buildConfig(APPS);
  assert.ok(!yml.includes("replicas:"), "deprecated replicas: array");
  // retention is legitimate only in the global snapshot block (2-space indent)
  assert.ok(!/^ {4,}retention:/m.test(yml), "replica-level retention:");
  assert.ok(!yml.includes("snapshot-interval:"), "replica-level snapshot-interval:");
});

test("buildConfig with no apps yields an empty dbs list", () => {
  const yml = makeLitestream().buildConfig([]);
  assert.ok(yml.endsWith("dbs:\n  []\n"));
});

test("generated config parses under the real litestream binary", { skip: !haveLitestream }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ls-config-"));
  const cfgPath = join(dir, "litestream.yml");
  writeFileSync(cfgPath, makeLitestream().buildConfig(APPS));
  // `databases -config` fails fast on schema errors (e.g. bad durations);
  // exit 0 = the config is well-formed for this pinned binary.
  execFileSync(litestreamBin, ["databases", "-config", cfgPath], { stdio: "pipe" });
});

// --- Housekeeping cadences ---------------------------------------------------
// These are the S3 REQUEST bill: litestream runs each of them as a fixed timer
// per database, whether or not the database was written to, and each tick LISTs
// the replica. Measured 2026-08-24 on the prod fleet: 16.5M ListBucket in 24
// days (82.60 USD) vs 50k PutObject (0.25 USD).
//
// Parsing is NOT enough to test. 0.5.x config parsing is non-strict, so a key
// that this binary does not know is dropped in silence and the built-in default
// applies — the config would still parse, and we would keep paying while
// believing we had slowed it down. The only honest oracle is the running
// daemon's own report of the intervals it started, so that is what we assert.

test("config knobs change the emitted cadences", () => {
  const yml = makeLitestream({
    LITESTREAM_L0_RETENTION: "30m",
    LITESTREAM_L0_RETENTION_CHECK_INTERVAL: "5m",
    LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h",
  }).buildConfig(APPS);
  assert.ok(yml.startsWith("l0-retention: 30m\nl0-retention-check-interval: 5m\nlevels:\n"));
  assert.ok(yml.includes("  - interval: 5m\n  - interval: 30m\n  - interval: 6h\n"));
});

test("a malformed duration fails the boot instead of being silently dropped", () => {
  assert.throws(() => makeLitestream({ LITESTREAM_L0_RETENTION: "5 minutes" }), /invalid LITESTREAM_L0_RETENTION/);
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION_CHECK_INTERVAL: "300" }),
    /invalid LITESTREAM_L0_RETENTION_CHECK_INTERVAL/,
  );
  assert.throws(() => makeLitestream({ LITESTREAM_LEVEL_INTERVALS: "5m,oops" }), /invalid LITESTREAM_LEVEL_INTERVALS/);
});

test("levels must be ordered slowest-last (an inverted pair recompacts forever)", () => {
  assert.throws(
    () => makeLitestream({ LITESTREAM_LEVEL_INTERVALS: "5m,30s" }),
    /level 2 must be slower than level 1/,
  );
  assert.throws(() => makeLitestream({ LITESTREAM_LEVEL_INTERVALS: "5m,5m" }), /must be slower/);
});

test(
  "the real binary HONOURS the cadences (not merely parses them)",
  { skip: !haveLitestream },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cadence-"));
    const dbPath = join(dir, "app.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t(a)");
    db.close();

    const cfgPath = join(dir, "litestream.yml");
    const cfg = makeLitestream({
      LITESTREAM_L0_RETENTION: "30m",
      LITESTREAM_L0_RETENTION_CHECK_INTERVAL: "5m",
      LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h",
    }).buildConfig([{ orgId: "org-a", appId: "app-1", dbPath }]);
    // point the replica at a local dir rather than the placeholder s3-ish url
    writeFileSync(cfgPath, cfg.replace(/url: .*/, `url: file://${join(dir, "replica")}`));

    const child = spawn(litestreamBin, ["replicate", "-config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !/L0 retention monitor/.test(out)) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      child.kill("SIGKILL");
    }

    assert.match(out, /L0 retention monitor.*interval=5m0s retention=30m0s/);
    assert.match(out, /compaction monitor.*level=1 interval=5m0s/);
    assert.match(out, /compaction monitor.*level=2 interval=30m0s/);
    assert.match(out, /compaction monitor.*level=3 interval=6h0m0s/);
  },
);

// --- The one setting here that loses DATA, not money -------------------------
// Every other knob trades cost against restore speed. `l0-retention` against the
// level-1 interval does not: a transaction lands in L0 first and may only be
// swept once level 1 has merged it, so too short a retention deletes writes that
// were never copied anywhere else. Nothing reports it — litestream keeps
// replicating, every metric stays green, and the loss surfaces the day someone
// restores. And it is easy to reach BY ACCIDENT, because the two values are
// tuned for opposite reasons: slowing compaction is what saves the money, and
// the retention is the one you forget to move with it.

test("l0-retention shorter than the level-1 interval refuses to boot", () => {
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION: "1m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" }),
    /LOST data/,
  );
});

test("l0-retention merely EQUAL to the level-1 interval is refused too — that is a race, not a margin", () => {
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION: "5m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" }),
    /LOST data/,
  );
  // …and so is anything under the required ratio.
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION: "9m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" }),
    /LOST data/,
  );
});

test("the required margin is met by the shipped defaults and by every offered option", () => {
  // The guard must not refuse what we actually intend to run — including
  // litestream's own defaults, which the shipped config reproduces verbatim.
  assert.ok(makeLitestream()); // defaults: 5m retention vs 30s L1
  const options: Array<[string, string]> = [
    ["10m", "1m,10m,1h"], // prudent
    ["1h", "5m,30m,6h"], // recommended
    ["3h", "15m,1h,6h"], // maximal
  ];
  for (const [retention, levels] of options) {
    assert.ok(
      makeLitestream({ LITESTREAM_L0_RETENTION: retention, LITESTREAM_LEVEL_INTERVALS: levels }),
      `${retention} / ${levels}`,
    );
  }
});

test("the guard states the fix, not just the refusal", () => {
  // A boot that dies on an unexplained assertion at 3am is a worse outcome than
  // the misconfiguration; the message must carry both values and the rule.
  try {
    makeLitestream({ LITESTREAM_L0_RETENTION: "1m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" });
    assert.fail("expected a refusal");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /1m/, "names the offending retention");
    assert.match(msg, /5m/, "names the level-1 interval it must clear");
    assert.match(msg, /at least 2x/i, "states the rule");
  }
});

test(
  "the real binary honours the SHIPPED cadence — the one prod actually runs",
  { skip: !haveLitestream },
  async () => {
    // The test above proves the knobs work with arbitrary values. This one
    // proves the values we actually ship are honoured, which is a different
    // claim: a default that only LOOKS applied would keep the fleet on
    // litestream's 15s/30s and nobody would notice, because the bill is the
    // only symptom and it arrives a month later.
    const dir = mkdtempSync(join(tmpdir(), "ls-shipped-"));
    const dbPath = join(dir, "app.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t(a)");
    db.close();

    const cfgPath = join(dir, "litestream.yml");
    const cfg = makeLitestream().buildConfig([{ orgId: "org-a", appId: "app-1", dbPath }]);
    writeFileSync(cfgPath, cfg.replace(/url: .*/, `url: file://${join(dir, "replica")}`));

    const child = spawn(litestreamBin, ["replicate", "-config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !/L0 retention monitor/.test(out)) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      child.kill("SIGKILL");
    }

    assert.match(out, /L0 retention monitor.*interval=30m0s retention=3h0m0s/);
    assert.match(out, /compaction monitor.*level=1 interval=30m0s/);
    assert.match(out, /compaction monitor.*level=2 interval=2h0m0s/);
    assert.match(out, /compaction monitor.*level=3 interval=6h0m0s/);
    // and NOT litestream's own defaults, which is the failure being guarded
    assert.doesNotMatch(out, /L0 retention monitor.*interval=15s/);
    assert.doesNotMatch(out, /compaction monitor.*level=1 interval=30s/);
  },
);
