#!/usr/bin/env node
// Load harness for the question that decides how many apps fit on one VM:
// does litestream's cost per database stay LINEAR as the count grows?
//
// Everything projected so far — RAM per base, restore seconds per app — comes
// from a single measurement at 61 databases on 2026-08-24. A straight line
// through one point is an assumption, not a curve, and the highest number
// litestream itself publishes anywhere is 400 (issue #1051 reported instability
// at 383). The target is 10 000. So this looks for a KNEE, not a confirmation.
//
// TWO PHASES, and the order is the whole point:
//
//   seed    — create N databases and let litestream replicate them to the
//             replica target, so replicas actually exist.
//   restore — delete the local files and boot again.
//
// Only the second phase measures restoration. Booting N empty databases would
// exercise `initFreshDb`, a different code path that never touches the replica
// — it would produce a fast, meaningless number and it is the easiest way to
// get this test wrong.
//
// A SECOND harness lives beside this one: `scripts/loadtest-ec2-userdata.sh`,
// which measures litestream ALONE (no service, no Node) on a disposable EC2
// instance. Use that one for the platform and backend questions — this file
// runs the real service but only on the developer's machine, and the 2026-08-24
// run proved that matters: on macOS the marginal cost per database appeared to
// FALL with N, while on linux/arm64 it rises. The trend was an artifact.
//
// Usage:
//   node scripts/loadtest.mjs --n 500 --replica file:///tmp/lt-replicas
//   node scripts/loadtest.mjs --n 500,1000,2500 --replica s3://bucket/prefix
//
// Emits one JSON line per tier on stdout (and a table on stderr), so a run can
// be piped straight into a file and re-plotted later.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const TIERS = String(arg("n", "500")).split(",").map((s) => Number(s.trim()));
const REPLICA = arg("replica", `file://${join(tmpdir(), "lt-replicas")}`);
const SETTLE_MS = Number(arg("settle", "20000"));
const CONCURRENCY = arg("concurrency", "8");

/** RSS of a pid, in bytes — Linux /proc first, ps as the portable fallback. */
function rssBytes(pid) {
  if (pid == null) return null;
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux, or gone */ }
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) * 1024;
  } catch {
    return null;
  }
}

function memAvailableBytes() {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function registryFor(n) {
  // One org, N apps: the shape that stresses the per-database machinery rather
  // than the registry. Which org they belong to is irrelevant to litestream.
  return Array.from({ length: n }, (_, i) => ({
    org_id: "loadtest-org",
    app_id: `app-${String(i).padStart(6, "0")}`,
    status: "active",
  }));
}

async function bootOnce({ dir, n, replica, label }) {
  // Imported lazily and per-tier so each boot starts from a clean module state.
  const { bootService } = await import("../service/src/boot.ts");
  const { loadConfig } = await import("../service/src/config.ts");

  const registryFile = join(dir, "registry.json");
  writeFileSync(registryFile, JSON.stringify(registryFor(n)));

  const cfg = loadConfig({
    PORT: "0",
    DB_DIR: join(dir, "dbs"),
    REGISTRY_MODE: "file",
    REGISTRY_FILE: registryFile,
    REPLICA_BASE_URL: replica,
    LITESTREAM_BIN: join(process.cwd(), ".toolchain", "litestream"),
    LITESTREAM_CONFIG_PATH: join(dir, "litestream.yml"),
    BOOT_RESTORE_CONCURRENCY: CONCURRENCY,
    HEARTBEAT_ENABLED: "0",
    IMDS_ENABLED: "0",
    REGISTRY_POLL_SECONDS: "86400", // no reconciliation noise during a measurement
  });

  const startedAt = Date.now();
  const svc = await bootService(cfg, { installSignalHandlers: false });
  const bootMs = Date.now() - startedAt;

  // Let replication reach steady state before reading memory: the number that
  // matters is the plateau, not the spike a boot produces.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const pid = svc.litestream.childPid;
  const sample = {
    label,
    apps: n,
    concurrency: Number(CONCURRENCY),
    bootMs,
    litestreamRssBytes: rssBytes(pid),
    nodeRssBytes: process.memoryUsage().rss,
    memAvailableBytes: memAvailableBytes(),
  };
  sample.rssPerAppBytes = sample.litestreamRssBytes === null ? null : Math.round(sample.litestreamRssBytes / n);
  sample.bootMsPerApp = Number((bootMs / n).toFixed(2));

  await svc.stop();
  return sample;
}

const results = [];
for (const n of TIERS) {
  const dir = mkdtempSync(join(tmpdir(), `loadtest-${n}-`));
  mkdirSync(join(dir, "dbs"), { recursive: true });
  try {
    // Phase 1 — seed: create the databases and let them replicate.
    const seed = await bootOnce({ dir, n, replica: `${REPLICA}/${n}`, label: "seed" });
    console.log(JSON.stringify(seed));
    results.push(seed);

    // Phase 2 — restore: wipe local state so the boot MUST pull from replicas.
    rmSync(join(dir, "dbs"), { recursive: true, force: true });
    mkdirSync(join(dir, "dbs"), { recursive: true });
    const restore = await bootOnce({ dir, n, replica: `${REPLICA}/${n}`, label: "restore" });
    console.log(JSON.stringify(restore));
    results.push(restore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The table is on stderr so stdout stays a clean JSON stream.
const fmtMb = (b) => (b === null ? "  n/a" : (b / 1048576).toFixed(1).padStart(7));
console.error("\nphase    apps   boot(s)  ms/app   litestream RSS(MB)  RSS/app(KB)");
for (const r of results) {
  console.error(
    `${r.label.padEnd(8)}${String(r.apps).padStart(5)}  ${(r.bootMs / 1000).toFixed(1).padStart(7)}  ` +
      `${String(r.bootMsPerApp).padStart(6)}  ${fmtMb(r.litestreamRssBytes)}             ` +
      `${r.rssPerAppBytes === null ? "n/a" : (r.rssPerAppBytes / 1024).toFixed(1)}`,
  );
}
console.error(
  "\nRead the LAST two columns, not the totals: a flat ms/app and a flat RSS/app mean linear\n" +
    "(the architecture holds the target, only sizing remains). Either one rising is the knee,\n" +
    "and where it rises is the apps-per-VM number.\n",
);
