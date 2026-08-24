import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface Config {
  port: number;
  dbDir: string;
  registryMode: "file" | "ddb";
  registryFile: string;
  registryTable: string;
  awsRegion: string;
  sqlTimeoutMs: number;
  txOpTimeoutMs: number;
  maxInflightPerApp: number;
  maxInflightTotal: number;
  maxLiveWorkers: number;
  txIdleMs: number;
  txMaxMs: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  maxSqlBytes: number;
  registryCacheMs: number;
  registryPollSeconds: number;
  /** How long an org's `maxDbMb` stays trusted before it is re-read (quota.ts).
   *  Raising a cap for a blocked customer must take effect in seconds, not
   *  minutes — hence a short TTL on a cheap single-item read. */
  orgQuotaCacheMs: number;
  litestreamDisabled: boolean;
  litestreamBin: string;
  litestreamConfigPath: string;
  replicaBaseUrl: string;
  litestreamSyncIntervalMs: number;
  litestreamRetention: string;
  litestreamSnapshotInterval: string;
  /** Housekeeping cadences. These drive the S3 REQUEST bill, not durability:
   *  litestream runs each of them as a FIXED timer per database, whether or not
   *  that database was written to, and each tick LISTs the replica prefix. The
   *  loss window on a brutal VM death is set by `sync-interval` alone — these
   *  only change how promptly L0 files are merged and swept, i.e. restore
   *  speed. Measured 2026-08-24: at litestream's OWN defaults (L0 sweep 15s,
   *  L1 30s, L2 5m, L3 1h) the fleet billed 16.5M ListBucket calls in 24 days
   *  (82.60 USD) against 50k PutObject (0.25 USD) — 99.7% of the S3 request
   *  bill was looking, not writing. Hence the slower cadence shipped below.
   *  The cost is strictly linear in the NUMBER of databases and independent of
   *  traffic, so it is a per-app floor: 1.343 USD/app/month at those defaults
   *  against 0.017 at the shipped ones. */
  litestreamL0Retention: string;
  litestreamL0RetentionCheckInterval: string;
  /** Compaction intervals for levels 1..N, in order (yaml `levels[].interval`). */
  litestreamLevelIntervals: string[];
  /** How many app databases boot-restore concurrently (spec §4 steps 2-3).
   *  Invariant 2 is unchanged — EVERY app is still restored before the port
   *  binds; only the order within that window becomes concurrent.
   *  Measured on prod 2026-08-24 (instance replaced by the 0.1.19 deploy):
   *  61 apps restored SERIALLY in 72s, and the shape of that window is what
   *  matters — 54 of the 61 gaps were exactly 1s and only ONE was 14s, because
   *  a single org holds 1320 MB of the fleet's 1352 MB. So ~58 of those 72
   *  seconds were fixed per-app overhead (a litestream subprocess spawn plus
   *  S3 round-trips) paid on databases that are essentially empty. The window
   *  is LATENCY-bound, not bandwidth-bound, which is precisely the case where
   *  concurrency buys a near-linear speedup: at 8-wide the same fleet should
   *  land near the 14s floor set by that one real database.
   *  This matters because the whole window is a total outage — the Data API is
   *  unreachable for EVERY org until it ends — and it grows linearly with apps
   *  sold: ~1.15 s/app serially would be ~19 min at 1000 apps. */
  bootRestoreConcurrency: number;
  heartbeatEnabled: boolean;
  heartbeatPeriodSeconds: number;
  heartbeatDimension: string;
  imdsEnabled: boolean;
  drainMs: number;
  cloudMapServiceId: string;
  // Per-request capability token (spec §6 caller-binding). The shared HMAC
  // secret is resolved at boot: from Secrets Manager when CAPABILITY_SECRET_ARN
  // is set (prod), else from the CAPABILITY_SECRET env var (local/tests). Empty
  // is only tolerated when enforcement is off (rollout-compat window).
  capabilitySecret: string;
  capabilityEnforce: boolean;
}

/** A litestream duration (`5m`, `30s`, `1h`, `250ms`) in milliseconds, or null. */
export function durationToMs(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!m) return null;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

/**
 * How many times longer an L0 file must be RETAINED than the level-1 compaction
 * interval. Not a style preference — the boundary between a saving and data
 * loss. L0 is where a transaction lands first; it may only be swept once it has
 * been merged into L1. A file written just after a compaction waits nearly a
 * full interval for the next one, and that compaction takes time itself, so a
 * retention merely EQUAL to the interval races with it. Two full cycles is the
 * cheapest margin that is obviously sufficient — and it costs nothing, since
 * the entire replica's storage bills 0.78 USD/month against 82.60 USD of
 * requests.
 */
export const MIN_L0_RETENTION_RATIO = 2;

/**
 * Compaction level intervals, as a comma-separated list ordered L1, L2, …
 * Each level must be strictly slower than the one below it — litestream
 * compacts upwards, so an inverted pair would have a level repeatedly
 * recompacting what it already holds. Empty/unset keeps the defaults.
 */
export function parseLevelIntervals(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) return fallback;
  const ms: number[] = [];
  for (const p of parts) {
    const v = durationToMs(p);
    if (v === null) {
      throw new Error(`invalid LITESTREAM_LEVEL_INTERVALS entry: ${p} (expected a duration such as 5m)`);
    }
    ms.push(v);
  }
  for (let i = 1; i < ms.length; i += 1) {
    if (ms[i]! <= ms[i - 1]!) {
      throw new Error(
        `invalid LITESTREAM_LEVEL_INTERVALS: ${raw} (level ${i + 1} must be slower than level ${i})`,
      );
    }
  }
  return parts;
}

/**
 * The one combination of these settings that loses DATA rather than money.
 *
 * Every other knob here trades cost against restore speed. This pair does not:
 * a transaction lands in L0 first and is only safe to sweep once level 1 has
 * merged it, so an `l0-retention` shorter than the level-1 interval deletes
 * transactions that were never copied anywhere else. Nothing would report it —
 * litestream keeps replicating happily, every metric stays green, and the loss
 * only surfaces the day someone actually restores.
 *
 * It is easy to reach by accident precisely because the two values are tuned
 * for opposite reasons: slowing compaction is what saves the money, and the
 * retention is the number one forgets to move with it. Hence a boot-time
 * refusal rather than a line of documentation — the README already said it, and
 * a README cannot fail a deploy.
 */
export function assertL0RetentionCoversL1(l0Retention: string, levelIntervals: string[]): void {
  const retentionMs = durationToMs(l0Retention);
  const l1 = levelIntervals[0];
  if (retentionMs === null || l1 === undefined) return;
  const l1Ms = durationToMs(l1);
  if (l1Ms === null) return;
  if (retentionMs < l1Ms * MIN_L0_RETENTION_RATIO) {
    throw new Error(
      `invalid LITESTREAM_L0_RETENTION: ${l0Retention} is not safely longer than the level-1 ` +
        `compaction interval ${l1} — an L0 file swept before it is compacted into L1 is LOST data. ` +
        `Use at least ${MIN_L0_RETENTION_RATIO}x the level-1 interval.`,
    );
  }
}

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
    litestreamConfigPath: env.LITESTREAM_CONFIG_PATH ?? "/etc/dilaya/litestream.yml",
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

/**
 * Resolve the capability HMAC secret at boot. When CAPABILITY_SECRET_ARN is set
 * (the CDK stack injects it), fetch the plaintext SecretString from Secrets
 * Manager; otherwise fall back to the CAPABILITY_SECRET env var already loaded
 * into `cfg.capabilitySecret`. Fails closed: if enforcement is on but no secret
 * could be resolved, the boot aborts rather than run unauthenticated.
 *
 * The stack generates a RAW random secret string (no SecretStringTemplate), so
 * SecretString is the secret verbatim — no JSON key to unwrap.
 */
export async function resolveCapabilitySecret(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let secret = cfg.capabilitySecret;
  const arn = env.CAPABILITY_SECRET_ARN;
  if (arn !== undefined && arn !== "") {
    const client = new SecretsManagerClient({ region: cfg.awsRegion });
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
      secret = res.SecretString ?? "";
    } finally {
      client.destroy();
    }
  }
  if (cfg.capabilityEnforce && secret === "") {
    throw new Error("CAPABILITY_ENFORCE is on but no capability secret could be resolved");
  }
  return secret;
}
