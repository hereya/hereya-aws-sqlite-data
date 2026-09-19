// Generated litestream.yml must use the 0.5.x schema. This is load-bearing:
// 0.5.x config parsing is NON-STRICT — the legacy replica-level `retention:`
// and `snapshot-interval:` keys are silently ignored, which would shrink the
// restore window to the 24h defaults without any error. Snapshots moved to a
// global `snapshot: {interval, retention}` block and each db takes a single
// `replica:` (the `replicas:` array is deprecated).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APPS, haveLitestream, litestreamBin, makeLitestream } from "./helpers.ts";

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
      // The control socket, beside the config file: what lets one database
      // join or leave without restarting replication for the others.
      "socket:",
      "  enabled: true",
      "  path: /etc/dilaya/litestream.sock",
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

test("the socket block disappears when the socket is off or cannot be bound", () => {
  assert.ok(!makeLitestream({ LITESTREAM_SOCKET_PATH: "off" }).buildConfig(APPS).includes("socket:"));
  // sockaddr_un caps the path (~104 bytes): litestream would die on
  // `bind: invalid argument`, so a path that long means "no socket", not a crash.
  const long = makeLitestream({ LITESTREAM_CONFIG_PATH: `/${"x".repeat(120)}/litestream.yml` });
  assert.ok(!long.buildConfig(APPS).includes("socket:"));
  const custom = makeLitestream({ LITESTREAM_SOCKET_PATH: "/run/ls.sock" }).buildConfig(APPS);
  assert.ok(custom.includes("socket:\n  enabled: true\n  path: /run/ls.sock\n"));
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
