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
  /** How often per-app write stats are persisted, ms. The hot path only
   *  touches memory; this is the cost of making that memory survive an
   *  instance replacement. 0 disables persistence entirely. */
  writeStatsFlushMs: number;
  /** Days an app may go without CHANGING its database before it leaves the
   *  litestream config (it stays served and readable — see src/eviction.ts).
   *  0 disables eviction, which is the default: it is switched on
   *  deliberately, per environment. */
  evictionIdleDays: number;
  /** How often the eviction sweep runs, ms. Nothing about it is urgent — the
   *  thing it reclaims accrues over days — so this is deliberately slow. */
  evictionSweepMs: number;
  /** Hot handover on instance replacement (t_vm_zero_cut_handover).
   *  OFF by default and never inferred: switching it on is what makes two
   *  instances overlap, so an operator decides, the same way evictionIdleDays
   *  and spotPercentage are decided. With it off, every call site behaves
   *  exactly as before. */
  handoverEnabled: boolean;
  /** How long the replacement waits for proof that its predecessor stopped.
   *  On timeout it proceeds ANYWAY, loudly — which is what makes the flag safe
   *  to switch on before the ASG changes: with terminate-before-launch the old
   *  instance is already gone, so the wait always expires. */
  handoverTimeoutMs: number;
  /** How often the departing instance asks whether a replacement has announced
   *  itself. Only the FIRST observation matters — it dates the window. */
  handoverWatchMs: number;
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
