// Every env var the SERVICE reads must be something the STACK can set.
//
// The handover shipped its first wiring with `HANDOVER_ENABLED` read by
// `config/load.ts` and set by nobody: a switch with no wire. Every test passed,
// because each half was internally consistent — the gap was BETWEEN the infra
// and the service, which is exactly where no unit test looks. It would have
// been found the first time someone tried to switch the feature on, i.e. in
// front of a customer's databases.
//
// This walks the two files and fails when a name exists on one side only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = readFileSync(new URL("../service/src/config/load.ts", import.meta.url), "utf8");
const userData = readFileSync(new URL("../lib/stack/instance-user-data.ts", import.meta.url), "utf8");

/** `env.FOO` and `intEnv("FOO", …)` / `durationEnv("FOO", …)`. */
function envNamesRead(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]!);
  for (const m of src.matchAll(/(?:intEnv|durationEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g)) names.add(m[1]!);
  return names;
}

/** `FOO: …` inside the serviceEnv object literal. */
function envNamesSet(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s{8}([A-Z][A-Z0-9_]+):/gm)) names.add(m[1]!);
  return names;
}

// Names the service reads that the stack deliberately never sets. Two kinds,
// and BOTH are decisions rather than oversights — which is the point of
// listing them: a name that appears here was looked at, and a NEW unreachable
// name fails the test until someone either wires it or adds it with a reason.
const NOT_THE_STACK_S_JOB = new Set([
  // Supplied by AWS, by hereya, or only meaningful in local dev.
  "AWS_REGION",
  "REGISTRY_MODE",
  "REGISTRY_FILE",
  "CAPABILITY_SECRET",
  "PORT",
  "DB_DIR",
  "LITESTREAM_DISABLED",
  "LITESTREAM_BIN",
  "LITESTREAM_CONFIG_PATH",
  // Follows the config path; `off` is an on-the-box escape hatch (every change
  // falls back to the bounce), not something two deployments should disagree on.
  "LITESTREAM_SOCKET_PATH",
  // Tuning the service owns: sensible defaults in code, deliberately NOT
  // per-deployment knobs. Exposing one means deciding it should differ between
  // deployments, which none of these should.
  "DRAIN_MS",
  // How long a new app waits for a worker when none can be evicted: bounded by
  // the gateway's 30 s, not by anything a deployment knows.
  "WORKER_WAIT_MS",
  // Database moves (service/src/move/): the drain wait, the size above which a
  // move must be forced, how long the cell an app left keeps its files.
  "MOVE_DRAIN_MS",
  "MOVE_MAX_BYTES",
  "MOVE_KEEP_MS",
  "HEARTBEAT_PERIOD_SECONDS",
  "LITESTREAM_SNAPSHOT_INTERVAL",
  "MAX_INFLIGHT_TOTAL",
  "MAX_REQUEST_BYTES",
  "MAX_RESPONSE_BYTES",
  "MAX_SQL_BYTES",
  "ORG_QUOTA_CACHE_MS",
  "REGISTRY_CACHE_MS",
  "TX_IDLE_MS",
  "TX_MAX_MS",
  "TX_OP_TIMEOUT_MS",
]);

test("no service setting is unreachable from the stack", () => {
  const read = envNamesRead(load);
  const set = envNamesSet(userData);
  const unreachable = [...read].filter((n) => !set.has(n) && !NOT_THE_STACK_S_JOB.has(n)).sort();
  assert.deepEqual(
    unreachable,
    [],
    `these are read by the service but set by nothing — a switch with no wire: ${unreachable.join(", ")}`,
  );
});
