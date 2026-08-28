# dilaya/aws-sqlite-data

Hereya package (`iac: cdk`, `infra: aws`) providing **durable multi-tenant SQLite storage**
for Dilaya v2: one SQLite file per app on a self-healing EC2 Spot singleton, continuously
replicated to S3 by Litestream, served through an IAM-authorized (SigV4) HTTP "Data API"
behind API Gateway. Durable storage / disposable compute: the instance can die at any time;
the source of truth is S3.

## Architecture

```
connector Lambda ──SigV4──▶ API Gateway (HTTP API, IAM auth)
                              │ VPC Link v2 + Cloud Map (no load balancer)
                              ▼
                EC2 ASG singleton (Spot, t4g, AL2023 arm64, SSM-only)
                  └─ Data API service (Node 24, bundled)
                       ├─ one CHILD PROCESS per app db (SIGKILL = timeout)
                       ├─ litestream child: WAL → s3://bucket/<org>/<app>/app.db
                       ├─ registry poller/hot-add (DynamoDB, fail-closed)
                       └─ CloudWatch heartbeat (dead-man) ─▶ alarm ─▶ SNS ─▶ Telegram
```

- **Boot (strict)**: registry scan → `litestream restore` every active app **→ only then**
  bind HTTP → start replication → register in Cloud Map.
- **Timeouts**: per-request SQL deadline enforced by SIGKILLing the app's executor process —
  the only mechanism that stops a runaway query inside a single native `sqlite3_step`
  (worker-thread `terminate()` cannot; verified).
- **Isolation**: per-app in-flight cap (429) + global cap; ATTACH/DETACH/`VACUUM INTO`/
  write-PRAGMAs rejected; org/app pairs revalidated against the registry on EVERY request
  (defense in depth — the API never trusts its caller).
- **The databases' own disk is encrypted at rest** (root EBS volume, AWS-managed `aws/ebs` key),
  matching the replica bucket — which had been encrypted all along, so until 2026-08-25 the copy
  that travels was protected while the original was not. Size and encryption are both stated by
  the launch template (`rootVolumeGb`, default 30 GB); no customer-managed key is wired in, on
  purpose — see invariant 14 in CLAUDE.md.
- **App lifecycle is runtime**: adding an app = a DynamoDB registry row (`org_id`,
  `sk=app#<appId>`, `status=active`) — discovered by poll, `POST /admin/sync`, or
  request-path hot-add (restore-before-first-query). Never a CDK redeploy.
- **Six alarms on one topic** (`AlertTopic` → the Telegram relay when its two inputs are set):
  `<stack>-heartbeat` and `<stack>-no-instance` watch liveness (dead-man treatment — missing data
  BREACHES); `<stack>-registry-system-errors` and `<stack>-registry-throttles` watch the registry
  table's `SystemErrors`/`ThrottledRequests` (≥1 over 5 min, missing data is HEALTHY);
  `<stack>-memory-headroom` and `<stack>-disk-headroom` watch the two resources that decide how
  many apps this VM can hold (missing data is NOT breaching — silence there means the heartbeat
  stopped, and that alarm already pages). The disk one is the odd member of the family: it is the
  only resource nothing can give back, since an evicted app keeps its file, so its curve only ever
  goes up and a full volume is `SQLITE_FULL` for every org at once. The registry
  pair exists because that table resolves *every* customer database: a throttle on it breaks all of
  them at once, and it is invisible everywhere else — it is not a Lambda error and yields no gateway
  5xx when the caller retries. The relay announces every ALARM but suppresses a **birth-OK**
  (`INSUFFICIENT_DATA → OK`, `lib/heartbeat-relay/announce.js`), or each deploy that creates alarms
  would send one "recovered" per alarm; the per-alarm wording lives in `format.js`, so a registry
  throttle is never announced as a dead heartbeat.
- **Access log on the gateway stage** (`HttpApiAccessLogs`, 7-day retention): one JSON line per
  request with `routeKey`/`status`/`integrationStatus`/`integrationErrorMessage`/`sourceIp`/
  `requestId`. Same field set as the connector's API. The alarms above count failures; this is the
  only place that *names* one — an `integrationStatus` of `-` on a 5xx means the request never
  reached the VM, which is a different fault from one the VM answered. Added 2026-08-28: this
  gateway serves every app's database of every org and was the last of the three without it, so its
  5xx were unattributable by construction (20 087 requests/24 h, 2 of them 5xx, nothing to say
  which). Retention is short on purpose — these lines are only read to explain a 5xx a metric window
  already surfaced.

## HTTP API (all routes IAM-authorized)

| Route | Body | Notes |
|---|---|---|
| `POST /query` | `{org_id, app_id, sql, params?, transactionId?}` | typed params/records mirror the RDS Data API `SqlParameter`/`Field` shapes; 1MiB response cap |
| `POST /batch-execute` | `{org_id, app_id, sql, parameterSets, transactionId?}` | chunked inserts |
| `POST /tx/begin\|commit\|rollback` | `{org_id, app_id, transactionId?}` | tx ids are pair-scoped; idle 15s / max 60s |
| `POST /admin/sync` | `{}` | reconcile served apps against the registry now |
| `POST /admin/delete-app` | `{org_id, app_id}` | tears down the app's local db (close executor, drop from litestream, delete local file); **S3 replica retained**; used by the connector's `drop-schema` |
| `GET /stats?org_id&app_id` | – | `{dbSizeBytes}` (db + WAL on disk); used by the connector's `get-usage-report` |
| `GET /health` | – | status, apps, litestream up/down, vec (sqlite-vec version) |

**Org database quota.** `/query` and `/batch-execute` refuse a write with `DB_QUOTA_EXCEEDED`
(429) once the org's databases reach `maxDbMb`, read off the registry's `sk='org'` row (dilaya.eu
decides the number, the connector caches it there). This is where the cap has to live: a per-app
Lambda calls this API directly with its own capability token, so the connector never sees those
statements. Doctrine — no cap set / unreadable = **no limit** (fail open); nothing is ever
deleted; reads and space-freeing statements (`DELETE`/`DROP`/`VACUUM`) always pass; usage is the
measured size of the org's db files (main file only — `VACUUM` writes through the WAL, so
counting the WAL would make freeing space look like growth), cached 5–120 s depending on how
close the org is to its cap.

**Vector search (sqlite-vec).** The pinned `vec0` loadable extension is preloaded at the driver
level on every app connection: tenant SQL can `CREATE VIRTUAL TABLE t USING vec0(embedding
float[N])` and run KNN (`WHERE embedding MATCH :q ORDER BY distance LIMIT k`), but
`load_extension()` itself is never available to tenant SQL (loading is re-disabled right after the
preload). Boot fail-fasts if the extension doesn't load (`vec_version()` self-check).

## Package contract

Inputs (env/`-p`): `instanceType` (t4g.micro), `autoDelete`, `servicePort`, `sqlTimeoutMs`,
`maxInflightPerApp`, `maxLiveWorkers`, `registryPollSeconds`, `litestreamSyncIntervalMs`,
`litestreamRetention`, `litestreamL0Retention`, `litestreamL0RetentionCheckInterval`,
`litestreamLevelIntervals`, `amiId`, `telegramBotTokenParam` (SSM SecureString *name*),
`telegramChatId`.

**The housekeeping cadences are the S3 request bill; `litestreamSyncIntervalMs` is the loss
window. They are different axes.** Litestream runs the L0 retention sweep and each compaction
level as a *fixed timer per database*, whether or not that database was written to, and every
tick LISTs the replica prefix. So the cost tracks the NUMBER OF APPS, not traffic: a database
untouched for three weeks pays the same as a busy one. Measured on the production fleet over
2026-08-01..24 (69 active databases, litestream defaults): **16 520 269 `ListBucket` = 82.60 USD**
against **50 745 `PutObject` = 0.25 USD** — 99.7 % of the S3 request bill was looking, not
writing. The modelled rate at the defaults (L0 sweep 15s + L1 30s + L2 5m + L3 1h + snapshot 6h
= 8 956 LISTs/db/day x 69) lands within 11 % of the measured 688 344/day, and that arithmetic
also proves the 1 s replication loop does **not** list: if it did, it alone would bill 5.96 M/day,
8.7x the whole observed total.

The consequence is worth stating plainly, because it inverts the obvious move: **raising
`litestreamSyncIntervalMs` buys almost nothing and costs durability**, while slowing the
housekeeping intervals buys nearly all of it and costs only restore speed — the loss window on a
brutal VM death stays exactly `litestreamSyncIntervalMs`.

**One combination here loses DATA rather than money, and the service refuses to boot on it.**
`litestreamL0Retention` must be at least **2x** the level-1 interval: a transaction lands in L0
first and may only be swept once level 1 has merged it, so a shorter retention deletes writes that
were never copied anywhere else — and nothing reports it, since litestream keeps replicating and
every metric stays green until the day someone restores. Equal is not enough either: a file written
just after a compaction waits nearly a full interval for the next one, so an equal retention races
with it. The pair is easy to get wrong *by accident* precisely because the two values are tuned for
opposite reasons — slowing compaction is what saves the money, and the retention is the one you
forget to move with it. Hence `assertL0RetentionCoversL1` at boot rather than this paragraph: a
README cannot fail a deploy. Litestream's own config parsing is non-strict, so a key it does not recognise is
dropped in silence and the built-in default applies — which is why the service validates these
durations at boot and refuses to start on a malformed one, and why the test suite asserts
against the running daemon's reported intervals rather than merely against a config that parses.

**`amiId` — the VM image is pinned.** Default = a specific AL2023 arm64 image of eu-west-1
(`PINNED_AMI_ID` in `lib/ami-pin.ts`), *not* "the latest one". Replacing the
instance costs ~60 s with no Data API for every org, so it must never happen as a side effect:
with `latestAmazonLinux2023()` the image was re-resolved at every deploy, and the first deploy
after any AWS publication (~monthly) rolled production. Move the OS deliberately — bump
`PINNED_AMI_ID`, publish, roll out via a connector release — and announce it. Cost of the pin: OS
security patches arrive when we roll it, not by accident. `amiId=latest` restores the old
auto-resolving behaviour; outside eu-west-1 you must pass `latest` or a region-local arm64 AL2023
id (synth fails otherwise).

**`npm run check:ami` — the half that makes the pin safe.** The pin only stays defensible if
something notices when it falls behind, so the comparison is a command rather than a line in this
file:

```bash
npm run check:ami                  # pin vs the published AL2023 — needs no EC2 permission
npm run check:ami -- --stack <n>   # also check the image the instance is actually running
```

Exit codes are the interface: **0** in sync · **1** a newer AL2023 exists (or the instance is on
neither — a bumped pin that was published but never rolled out, which a deploy fixes) · **2** could
not determine. `2` is deliberately not `0`: a check that reports health while blind is worse than no
check. Run it before every publish, and on whatever schedule watches this package.

Outputs: `dataApiUrl`, `awsRegion`, `registryTableName`, `sqliteReplicaBucketName`,
`iamPolicySqliteDataApi` (execute-api:Invoke), `iamPolicySqliteRegistry` (DDB writes) —
the `iamPolicy*` outputs auto-attach to the consuming app's Lambda role.

## Development

```bash
npm install
npm test              # unit + integration + CDK assertions (downloads Node 24 + sqlite-vec toolchain)
npm run typecheck
npm run build-service # dist/service.tar.gz (hermetic: pinned sha256 Node + litestream + sqlite-vec)
```

Local service without AWS: `REGISTRY_MODE=file REGISTRY_FILE=... LITESTREAM_DISABLED=1 DB_DIR=... node --experimental-strip-types service/src/main.ts` (or use the toolchain node).

## Acceptance / chaos scripts (`scripts/acceptance/`, run against a deployed stack)

```bash
node scripts/acceptance/canary.mjs <dataApiUrl> <registryTable>   # signed round-trip + forged-pair 403
node scripts/acceptance/kill-instance.mjs <stackName>             # terminate → auto-recovery with data intact
node scripts/acceptance/kill-process.mjs <stackName>              # SIGKILL → systemd restart, no ASG event
node scripts/acceptance/cut-network.mjs <stackName>               # SG swap → dead-man ALARM → restore → OK
node scripts/acceptance/quota.mjs <dataApiUrl> <registryTable>    # db cap: refused past it, reads/DELETE/VACUUM still pass, lifting it unblocks
node scripts/acceptance/noisy-neighbor.mjs <stackName>            # flood one app → other app unaffected
.toolchain/node/bin/node scripts/acceptance/restore-legacy-0-3.mjs <stackName>  # 0.3-format replica restored by the 0.5 service
```

## Ops runbook

- **Normal service update**: a CDK deploy with a new `service.tar.gz` **replaces the instance
  automatically** (the artifact hash in user-data versions the launch template; the ASG rolling
  update terminates the old instance, then launches the new one — ~1 min write gap, restore from
  local files). No manual bounce needed since 0.1.8.
- **Service-only update (no CDK, emergency path)**: build `service.tar.gz`, upload to any readable
  S3 spot, update the `/<stack>/service-artifact` SSM parameter, then either restart the service
  via SSM (`systemctl restart dilaya-data-api` after re-running the fetch steps) or terminate the
  instance and let the ASG rebuild from the parameter.
- **Remove an app**: flip its registry row `status` (or delete the row) → the poller (or
  `/admin/sync`) closes it and deletes the LOCAL file. The **S3 replica is retained** as the
  durable archive; deleting `s3://bucket/<org>/<app>/` is a deliberate manual op.
- **Never** add S3 lifecycle rules or versioning to the replica bucket, and never mount the
  db files over the network — Litestream owns retention; only the Data API touches the files.
- **Spot loss window**: ≈ the litestream sync interval (1s default) on hard kills; clean
  interruptions drain (503 + checkpoint + final sync) to ~zero.
- Capacity rebalance stays OFF (two concurrent litestream writers on one generation path
  would corrupt it). Future overlap-style replacement requires the documented DDB lease.
- **`cdk destroy` caveat (mitigated)**: stack deletion terminates the instance without a
  drain, so its Cloud Map registration survives and would block the discovery-service
  deletion. A custom resource (`CloudMapDeregisterOnDelete`) now force-deregisters any
  lingering instances before the service is deleted — destroy completes in one pass. It
  fails open, so if deregistration itself errors the old manual runbook still applies:
  `aws servicediscovery list-instances --service-id <id>`, deregister each, re-run destroy.
- **Purchasing**: on-demand by default. Spot (`spotPercentage=100`) is cheaper but was
  observed unfulfillable across 2 AZs + 2 instance sizes for >10 min in eu-west-1 — accept
  open-ended outages before enabling it.
