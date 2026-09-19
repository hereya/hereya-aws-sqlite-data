import type { Config } from "./types.ts";
import { assertL0RetentionCoversL1, parseLevelIntervals } from "./durations.ts";
import { resolveSocketPath } from "../litestream/control.ts";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // port 0 is valid (ephemeral, used by tests); negatives and garbage are not
  function intEnv(name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(`invalid ${name}: ${raw}`);
    }
    return n;
  }

  // Litestream's config parser is NON-STRICT: a malformed duration is not an
  // error, it silently falls back to the built-in default — which is exactly
  // the failure this whole setting exists to avoid (we would keep paying the
  // 15s/30s bill while believing we had slowed it down). So the durations are
  // validated HERE, at boot, where a typo is loud.
  function durationEnv(name: string, fallback: string): string {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = raw.trim();
    if (!/^\d+(\.\d+)?(ms|s|m|h)$/.test(v)) {
      throw new Error(`invalid ${name}: ${raw} (expected a litestream duration such as 5m, 30s, 1h)`);
    }
    return v;
  }

  const registryMode = (env.REGISTRY_MODE ?? "ddb") as Config["registryMode"];
  if (registryMode !== "file" && registryMode !== "ddb") {
    throw new Error(`invalid REGISTRY_MODE: ${env.REGISTRY_MODE}`);
  }

  // A zero or absurd width would either stall the boot forever or spawn one
  // litestream subprocess per app at once; both are worse than the serial loop
  // this replaces, so the bound is validated here where a typo is loud rather
  // than clamped silently.
  const bootRestoreConcurrency = intEnv("BOOT_RESTORE_CONCURRENCY", 8);
  if (bootRestoreConcurrency < 1 || bootRestoreConcurrency > 64) {
    throw new Error(
      `invalid BOOT_RESTORE_CONCURRENCY: ${bootRestoreConcurrency} (expected 1..64)`,
    );
  }

  const litestreamConfigPath = env.LITESTREAM_CONFIG_PATH ?? "/etc/dilaya/litestream.yml";
  const l0Retention = durationEnv("LITESTREAM_L0_RETENTION", "3h");
  const levelIntervals = parseLevelIntervals(env.LITESTREAM_LEVEL_INTERVALS, ["30m", "2h", "6h"]);
  assertL0RetentionCoversL1(l0Retention, levelIntervals);

  return {
    port: intEnv("PORT", 8080),
    dbDir: env.DB_DIR ?? "/var/lib/dilaya/dbs",
    registryMode,
    registryFile: env.REGISTRY_FILE ?? "",
    registryTable: env.REGISTRY_TABLE ?? "",
    awsRegion: env.AWS_REGION ?? "eu-west-1",
    sqlTimeoutMs: intEnv("SQL_TIMEOUT_MS", 20_000),
    txOpTimeoutMs: intEnv("TX_OP_TIMEOUT_MS", 5_000),
    maxInflightPerApp: intEnv("MAX_INFLIGHT_PER_APP", 16),
    maxInflightTotal: intEnv("MAX_INFLIGHT_TOTAL", 64),
    maxLiveWorkers: intEnv("MAX_LIVE_WORKERS", 8),
    txIdleMs: intEnv("TX_IDLE_MS", 15_000),
    txMaxMs: intEnv("TX_MAX_MS", 60_000),
    maxResponseBytes: intEnv("MAX_RESPONSE_BYTES", 1_048_576),
    maxRequestBytes: intEnv("MAX_REQUEST_BYTES", 1_048_576),
    maxSqlBytes: intEnv("MAX_SQL_BYTES", 262_144),
    registryCacheMs: intEnv("REGISTRY_CACHE_MS", 30_000),
    registryPollSeconds: intEnv("REGISTRY_POLL_SECONDS", 30),
    orgQuotaCacheMs: intEnv("ORG_QUOTA_CACHE_MS", 30_000),
    litestreamDisabled: env.LITESTREAM_DISABLED === "1" || env.LITESTREAM_DISABLED === "true",
    litestreamBin: env.LITESTREAM_BIN ?? "litestream",
    litestreamConfigPath: litestreamConfigPath,
    litestreamSocketPath: resolveSocketPath(env.LITESTREAM_SOCKET_PATH, litestreamConfigPath),
    replicaBaseUrl: (env.REPLICA_BASE_URL ?? "").replace(/\/+$/, ""),
    litestreamSyncIntervalMs: intEnv("LITESTREAM_SYNC_INTERVAL_MS", 1000),
    litestreamRetention: env.LITESTREAM_RETENTION ?? "72h",
    litestreamSnapshotInterval: env.LITESTREAM_SNAPSHOT_INTERVAL ?? "6h",
    // The cadence Jonatan chose on 2026-08-24, after the scaling question:
    // 0.017 USD per app per month against 1.343 at litestream's own defaults.
    // The retention is 3h rather than the 1h the guard strictly requires — the
    // margin is free (all replica storage bills 0.78 USD/month) and the thing
    // it protects against is data loss.
    litestreamL0Retention: l0Retention,
    litestreamL0RetentionCheckInterval: durationEnv("LITESTREAM_L0_RETENTION_CHECK_INTERVAL", "30m"),
    litestreamLevelIntervals: levelIntervals,
    bootRestoreConcurrency: bootRestoreConcurrency,
    writeStatsFlushMs: intEnv("WRITE_STATS_FLUSH_MS", 300_000),
    // OFF by default. The safety of eviction rests on the threshold being far
    // larger than the replication lag, so the number is never inferred — an
    // operator sets it, or nothing is evicted.
    evictionIdleDays: intEnv("EVICTION_IDLE_DAYS", 0),
    evictionSweepMs: intEnv("EVICTION_SWEEP_MS", 3_600_000),
    // OFF unless explicitly switched on — see the type's comment.
    handoverEnabled: env.HANDOVER_ENABLED === "1" || env.HANDOVER_ENABLED === "true",
    handoverTimeoutMs: intEnv("HANDOVER_TIMEOUT_MS", 15_000),
    handoverWatchMs: intEnv("HANDOVER_WATCH_MS", 2_000),
    handoverAckMs: intEnv("HANDOVER_ACK_MS", 10_000),
    handoverOverlapTimeoutMs: intEnv("HANDOVER_OVERLAP_TIMEOUT_MS", 300_000),
    heartbeatEnabled: env.HEARTBEAT_ENABLED === "1" || env.HEARTBEAT_ENABLED === "true",
    heartbeatPeriodSeconds: intEnv("HEARTBEAT_PERIOD_SECONDS", 60),
    heartbeatDimension: env.HEARTBEAT_DIMENSION ?? "dilaya-sqlite-data",
    imdsEnabled: env.IMDS_ENABLED === "1" || env.IMDS_ENABLED === "true",
    drainMs: intEnv("DRAIN_MS", 5_000),
    cloudMapServiceId: env.CLOUDMAP_SERVICE_ID ?? "",
    // The Secrets Manager fetch is async (see resolveCapabilitySecret); here we
    // only seed the plaintext-env fallback used when no ARN is provided.
    capabilitySecret: env.CAPABILITY_SECRET ?? "",
    capabilityEnforce: env.CAPABILITY_ENFORCE === "true",
  };
}
