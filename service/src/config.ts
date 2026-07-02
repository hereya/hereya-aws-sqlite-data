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
  litestreamDisabled: boolean;
  litestreamBin: string;
  litestreamConfigPath: string;
  replicaBaseUrl: string;
  litestreamSyncIntervalMs: number;
  litestreamRetention: string;
  litestreamSnapshotInterval: string;
  heartbeatEnabled: boolean;
  heartbeatPeriodSeconds: number;
  heartbeatDimension: string;
  imdsEnabled: boolean;
  drainMs: number;
  cloudMapServiceId: string;
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

  const registryMode = (env.REGISTRY_MODE ?? "ddb") as Config["registryMode"];
  if (registryMode !== "file" && registryMode !== "ddb") {
    throw new Error(`invalid REGISTRY_MODE: ${env.REGISTRY_MODE}`);
  }
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
    litestreamDisabled: env.LITESTREAM_DISABLED === "1" || env.LITESTREAM_DISABLED === "true",
    litestreamBin: env.LITESTREAM_BIN ?? "litestream",
    litestreamConfigPath: env.LITESTREAM_CONFIG_PATH ?? "/etc/dilaya/litestream.yml",
    replicaBaseUrl: (env.REPLICA_BASE_URL ?? "").replace(/\/+$/, ""),
    litestreamSyncIntervalMs: intEnv("LITESTREAM_SYNC_INTERVAL_MS", 1000),
    litestreamRetention: env.LITESTREAM_RETENTION ?? "72h",
    litestreamSnapshotInterval: env.LITESTREAM_SNAPSHOT_INTERVAL ?? "6h",
    heartbeatEnabled: env.HEARTBEAT_ENABLED === "1" || env.HEARTBEAT_ENABLED === "true",
    heartbeatPeriodSeconds: intEnv("HEARTBEAT_PERIOD_SECONDS", 60),
    heartbeatDimension: env.HEARTBEAT_DIMENSION ?? "dilaya-sqlite-data",
    imdsEnabled: env.IMDS_ENABLED === "1" || env.IMDS_ENABLED === "true",
    drainMs: intEnv("DRAIN_MS", 5_000),
    cloudMapServiceId: env.CLOUDMAP_SERVICE_ID ?? "",
  };
}
