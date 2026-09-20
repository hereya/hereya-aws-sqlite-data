import type * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { buildUserData } from "../user-data.ts";
import type { StackContext } from "./context.ts";
import { input } from "./inputs.ts";

export function createUserData(stack: cdk.Stack, ctx: StackContext): void {
  const { table, bucket, artifact, artifactParam, discoveryService, capabilitySecret } = ctx;

  // --- Launch template + self-healing Spot singleton ----------------------
  ctx.userData = ec2.UserData.custom(
    buildUserData({
      awsRegion: stack.region,
      artifactParamName: artifactParam.parameterName,
      artifactHash: artifact.assetHash,
      serviceEnv: {
        NODE_ENV: "production",
        PORT: String(ctx.servicePort),
        DB_DIR: "/var/lib/dilaya/dbs",
        AWS_REGION: stack.region,
        REGISTRY_MODE: "ddb",
        REGISTRY_TABLE: table.tableName,
        REPLICA_BASE_URL: `s3://${bucket.bucketName}`,
        LITESTREAM_BIN: "/usr/local/bin/litestream",
        LITESTREAM_CONFIG_PATH: "/etc/dilaya/litestream.yml",
        SQL_TIMEOUT_MS: input("sqlTimeoutMs", "20000"),
        MAX_INFLIGHT_PER_APP: input("maxInflightPerApp", "16"),
        MAX_LIVE_WORKERS: input("maxLiveWorkers", "8"),
        REGISTRY_POLL_SECONDS: input("registryPollSeconds", "30"),
        LITESTREAM_SYNC_INTERVAL_MS: input("litestreamSyncIntervalMs", "1000"),
        LITESTREAM_RETENTION: input("litestreamRetention", "72h"),
        // Housekeeping cadence — the S3 REQUEST bill, not durability. See the
        // parameter docs in hereyarc.yaml.
        LITESTREAM_L0_RETENTION: input("litestreamL0Retention", "3h"),
        LITESTREAM_L0_RETENTION_CHECK_INTERVAL: input("litestreamL0RetentionCheckInterval", "30m"),
        LITESTREAM_LEVEL_INTERVALS: input("litestreamLevelIntervals", "30m,2h,6h"),
        // Boot-restore fan-out. This is an AVAILABILITY setting, not a cost
        // one: the whole restore window is a total outage for every org, and
        // it was serial until 2026-08-24 (61 apps, 72s measured). See the
        // parameter docs in hereyarc.yaml.
        BOOT_RESTORE_CONCURRENCY: input("bootRestoreConcurrency", "8"),
        // Per-app write recency — the hot path is memory only; this is how
        // often it is persisted so it survives an instance replacement.
        WRITE_STATS_FLUSH_MS: input("writeStatsFlushMs", "300000"),
        // Eviction: days without a WRITE before an app leaves the litestream
        // config (it stays served and readable). "0" = off, and off is the
        // default on purpose — the threshold is what makes eviction safe (it
        // must dwarf the ~1s replication lag), so it is never inferred.
        EVICTION_IDLE_DAYS: input("evictionIdleDays", "0"),
        EVICTION_SWEEP_MS: input("evictionSweepMs", "3600000"),
        // Hot handover on instance replacement (t_vm_zero_cut_handover).
        // "false" = the instance boots exactly as it always has. Switching it
        // on is what makes two instances overlap, so it is an operator's
        // decision, like evictionIdleDays and spotPercentage above.
        // ⚠️ The service reads these names; without this block the flag is
        // unreachable — a switch with no wire, which is how it shipped in the
        // first draft of the wiring.
        HANDOVER_ENABLED: input("handoverEnabled", "false"),
        HANDOVER_TIMEOUT_MS: input("handoverTimeoutMs", "15000"),
        HANDOVER_WATCH_MS: input("handoverWatchMs", "2000"),
        HANDOVER_ACK_MS: input("handoverAckMs", "10000"),
        HANDOVER_OVERLAP_TIMEOUT_MS: input("handoverOverlapTimeoutMs", "300000"),
        HEARTBEAT_ENABLED: "1",
        HEARTBEAT_DIMENSION: stack.stackName,
        IMDS_ENABLED: "1",
        CLOUDMAP_SERVICE_ID: discoveryService.serviceId,
        // The stack runs ONE cell, the origin: it owns every app that has no
        // placement row (service/src/placement.ts). Stated rather than left to
        // the default, so a second cell cannot appear without choosing its id.
        CELL_ID: "0",
        // Capability-token validation: the service fetches the secret by ARN
        // at boot. Enforcement defaults OFF (rollout-compat window) — flip via
        // the capabilityEnforce input once every connector mints tokens.
        CAPABILITY_SECRET_ARN: capabilitySecret.secretArn,
        CAPABILITY_ENFORCE: input("capabilityEnforce", "false"),
      },
    }),
  );
}
