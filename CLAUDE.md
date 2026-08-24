# hereya-aws-sqlite-data — dev notes

Hereya package `dilaya/aws-sqlite-data`. README.md has the architecture, API, contract and
runbook; this file is the working-agreement layer for agents.

## Load-bearing invariants (do not "fix" these)

1. **Executors are child processes, not worker threads.** A runaway query inside one native
   `sqlite3_step` (e.g. `SELECT MAX(x)` over an infinite recursive CTE) is NOT interruptible
   by `worker.terminate()` — only SIGKILL stops it (verified experimentally; node:sqlite has
   no `interrupt()`). Timeout = kill the child; WAL makes it crash-safe. All child event
   handlers guard on `this.child !== child` (stale exit/reply races).
2. **Restore-if-missing, both directions.** Never let a worker create an empty db before
   `litestream restore -if-replica-exists` ran (masks S3 data); never restore over an
   existing local file (clobbers newer local writes). `AppSync.ensureServed` is the request-
   path gate; boot restores everything before the port binds.
3. **Fail-closed everywhere.** Registry unreadable → 503, unknown/inactive pair → 403,
   errors never cached, tx ids scoped to their org/app pair. The VM revalidates every
   request independently of the connector (spec §6 double control).
4. **No S3 lifecycle rules / versioning on the replica bucket** — Litestream owns retention.
   Template test enforces it.
5. **Capacity rebalance OFF** on the ASG — replacement-before-terminate would run two
   litestream writers on one generation path. Same reason the update policy is a **rolling
   update with `minInstancesInService: 0`** (terminate-before-launch): never switch it (back)
   to `replacingUpdate()`, which runs old and new instances side by side.
6. **Wire shapes mirror the RDS Data API** (`SqlParameter[]`, `records`/`columnMetadata`/
   `numberOfRecordsUpdated`, `Field` union incl. base64 `blobValue`; INTEGER beyond ±2^53 →
   `stringValue`) so the connector's `convertParams`/`extractFieldValue` round-trip unchanged.
7. **SQL guards are duplicated by design**: ATTACH/DETACH, `VACUUM INTO`, PRAGMA outside the
   read-only allowlist are rejected HERE even though the connector also rejects them.
8. **sqlite-vec (vec0) is preloaded per-connection, never tenant-loadable.** `openConn` opens
   with `allowExtension: true`, loads the pinned `vec0`, then `enableLoadExtension(false)` —
   tenant SQL gets the `vec_*` functions and vec0 virtual tables but never `load_extension()`.
   Boot asserts `vec_version()` (fail-fast) before restoring/serving anything.
9. **`longValue`/`booleanValue` params bind as `bigint`, not `number`.** node:sqlite binds a JS
   number with `sqlite3_bind_double` even when integral; ordinary column affinity hides it, but
   vec0 rejects a REAL rowid. Don't "simplify" the BigInt conversion in marshalling.
10. **The db quota FAILS OPEN — the one check here that does.** Everything else on this VM is
    fail-closed because it answers "may this caller touch this app". `maxDbMb` answers "has this
    customer bought enough space": an unreadable cap, an absent attribute or `null` = NO cap.
    Refusing an org's own writes because DynamoDB blinked is a worse failure than one unenforced
    cap. Reads and space-freeing statements (`DELETE`/`DROP`/`VACUUM`) always pass, and the quota
    measures the **main db file only, never the WAL** — `VACUUM` rewrites the database through
    the WAL, so counting it would make freeing space look like growth. See `service/src/quota.ts`.
11. **A NEW SERVICE rolls the instance — a new BUILD must not.** The hash line in
    `buildUserData` is an inert comment but load-bearing: it versions the launch template, so
    a changed hash makes the rolling update replace the instance (~1 min gap with no Data API,
    same sequence as the tested kill-instance recovery). That is why the hash comes from
    `serviceContentHash()` (`lib/service-hash.ts`) — the service SOURCES plus the pinned
    node/litestream/sqlite-vec versions and the build script — and **not** from the built
    tarball. It used to be `AssetHashType.OUTPUT`, i.e. a hash of `service.tar.gz`, which is not
    reproducible (`version.json.builtAt` + tar/gzip mtimes): two builds of identical source gave
    two hashes, so **every deploy of anything rolled the production databases** — five times in
    forty hours on 2026-07-29/30, none of them a change to this service, ~60 s of unreachable
    Data API each (visitors of customer sites logged out, and the login page down with it).
    Keep the hash on the inputs; `test/service-hash.test.ts` pins it. The SSM artifact pointer
    remains the emergency service-only path (manual re-fetch + restart, no CDK).
12. **The AMI is a constant, not a lookup.** The second silent roll trigger used to be
    `MachineImage.latestAmazonLinux2023()`: it re-resolves at EVERY deploy, so the first deploy
    following an AWS publication (~monthly — 2026-06-26, 2026-07-25, 2026-08-03) replaced the instance, same
    ~60 s outage as above, on an unrelated release. The image id now lives in `PINNED_AMI_ID` /
    `PINNED_AMI_REGION` (top of the stack file) and reaches the launch template through
    `resolveMachineImage()`. Roll the OS deliberately: read
    `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64`, bump the constant, publish,
    connector release, announce. Accepted cost: OS patches no longer arrive by accident — so
    **`npm run check:ami` is the half that makes the pin safe** (`lib/ami-pin.ts`, added 2026-08-03):
    it compares the pin with what AWS publishes and **exits non-zero** when a newer AL2023 exists, so
    a roll gets planned instead of forgotten. It exits **2** — never 0 — when it cannot read, because
    a check that passes while blind is worse than none. Add `--stack <name>` to also catch a pin that
    was bumped and published but never rolled out (reported separately: that one is fixed by a
    deploy, not an edit) — and pass the **FULL** stack name: the tag filter is an exact match, so a
    truncated one selects nothing. That is not hypothetical. On 2026-08-05 the sweep ran with
    `p-263b1e67` instead of `p-263b1e67-4f7d-498a-8f5a-8635f2e68a87`; the empty result was
    indistinguishable from "no permission", the command exited 0, and the `instance-stale` branch had
    never once run since it shipped. Now an unanswered instance question **cannot exit 0**
    (`exitCodeFor`): a bad name exits 2 saying so and suggests the full one, a behind pin still
    outranks it with 1. This replaced a prose instruction that lived in two documents and was
    never once executed — a stale image went unnoticed for four weeks. `amiId=latest` re-enables
    auto-resolution
    (surprise roll included); an id is region-scoped, so the default is refused outside
    `PINNED_AMI_REGION` rather than producing an ASG that can't launch. With this, the ONLY things
    that touch the production databases are a new service and a bumped pin — both deliberate.

## Working on it

- `npm test` = unit + integration (in-process boots, real litestream with `file://` replicas)
  + CDK template assertions. Tests run under the pinned toolchain Node 24 (`.toolchain/`),
  NOT the system node (node:sqlite + `StatementSync.columns()` need ≥23.11).
- Registry schema (shared with the connector): PK `org_id`, SK `sk` ∈ {`org`, `app#<appId>`,
  `name#<name>`}; the VM reads only `app#` rows (+`status`). `status` is a DDB reserved word
  — always alias it (`#s`) in expressions.
- The service artifact is hermetic: `scripts/build-service.mjs` pins Node + litestream +
  sqlite-vec by sha256 (`scripts/pins.json`). Bump versions via
  `scripts/{node,litestream,sqlite-vec}-version.txt` and REVIEW the new pins before committing
  (GitHub's release API exposes per-asset sha256 digests to cross-check).
- cdk.json runs the app through `npx tsx` (package is ESM; ts-node would choke).
  The repo-local `aws-cdk` devDependency matters: the CLI must be ≥ the lib's cloud-assembly
  schema (a too-old global cdk silently no-ops with a schema-mismatch notice).
- Deploy for dev: `AWS_PROFILE=<p> AWS_REGION=eu-west-1 STACK_NAME=<name> autoDelete=true
  npx cdk deploy` — with `autoDelete=true`, `cdk destroy` removes bucket + table too.
- Release: bump `hereyarc.yaml` version → commit → tag `v<version>` → push → `hereya publish`.

## Observed behaviors (dev acceptance, 2026-07-02)

- Kill-instance recovery: **53s** end-to-end (terminate → new on-demand instance →
  restore → first successful query). Kill-process: systemd restart < 10s, no ASG event.
  ⚠ That 53s was measured on a handful of apps and **no longer describes the fleet** — see the
  2026-08-24 measurement below.
- Noisy-neighbor: victim p95 143→144ms under a 40-bomb flood. A flooding app's QUEUED
  requests can exceed API Gateway's 30s integration timeout → the gateway returns 503
  (retryable) for those; per-app cap returns 429; the SQL deadline returns 408. All three
  are contained to the offending app.
- **Spot reality check**: t4g Spot went unfulfillable across 2 AZs + 2 sizes in eu-west-1
  for >10 min — that's why the default is on-demand (`spotPercentage=0`); Spot is opt-in.

## Boot-restore window (prod measurement, 2026-08-24)

Measured on the instance the 0.1.19 deploy replaced (`i-0a5e2f9882637bdcf`, 10:15:28 → 10:16:40):
**61 apps, 72s, serial** — and the whole window is a TOTAL OUTAGE, since invariant 2 binds the
port only after the last restore.

The shape matters more than the total: **54 of the 61 inter-restore gaps were exactly 1s and only
one was 14s**, because a single org holds **1320 MB of the fleet's 1352 MB**. So ~58 of those 72
seconds were fixed per-app overhead (litestream subprocess spawn + S3 round-trips) paid on
near-empty databases. The window is **latency-bound, not bandwidth-bound** — which is why the fix
was concurrency (`bootRestoreConcurrency`, default 8) and NOT lazy restore: the bound is removed
without trading away restore-then-serve. Serially it was ~1.15 s/app, i.e. ~19 min at 1000 apps.

The other half of that measurement, for the record: **litestream bounces are NOT a scaling term.**
`doSync` bounces only `if (added > 0 || removed > 0)`, so the reconciliation timer never restarts
replication on its own — confirmed by 30 min of prod journal with a single `replicate-started` and
no exit. Real creation rate: 61 apps over 51 days, peak 15 in one day = ~15s of cumulative
replication pause on the worst day.

## Capacity telemetry (2026-08-24, `service/src/capacity.ts`)

The heartbeat answers "is it alive". These answer the question that arrives
BEFORE death — **"how many more apps fit"** — and nothing could answer it until
now: the only way to read litestream's memory was an SSM session and `ps` by
hand, which is to say it was never read.

Three metrics in `Dilaya/SqliteData`, published on the heartbeat's own timer and
in the same `PutMetricData` call: `LitestreamRssBytes`, `MemoryAvailableBytes`,
`ServedApps`. Raw, never pre-divided — RSS-per-app is the interesting quantity,
but a ratio computed on the box is a number nobody can re-slice; CloudWatch
metric math divides at read time.

**The two silences are opposite, and that is the whole design.** The `Heartbeat`
datum is published ONLY when healthy (its absence *is* the alarm). The capacity
data is published ALWAYS — the moment memory matters most is the moment the
service is struggling, so gating it on health would hide the one event it exists
to catch. `service/test/unit/heartbeat-capacity.test.ts` pins both directions.

`MemAvailable`, not `MemFree`: MemFree looks alarming on any healthy Linux box
because the page cache is doing its job. Every `/proc` read returns `null` rather
than throwing — a bounce is ~1s during which the pid just read no longer exists,
and a metrics probe must never be what takes the service down. `procRoot` is
injectable so the publishing path is testable on macOS, which has no `/proc`.

Alarm `${stackName}-memory-headroom` fires under `memoryHeadroomBytes` (default
150 MB). It is `notBreaching` on missing data, unlike its neighbours: silence
here means the heartbeat stopped, and that alarm already pages — two alerts for
one incident is noise, and noise is how alarms get ignored.
## Load harness + the memory model (2026-08-24, `scripts/loadtest.mjs`)

```
node scripts/loadtest.mjs --n 500,1000,2500 --replica s3://bucket/prefix
```

Two phases per tier, and **the order is the whole point**: `seed` creates N
databases and lets them replicate, `restore` deletes the local files and boots
again. Only the second measures restoration — booting N empty databases runs
`initFreshDb`, never touches the replica, and yields a fast meaningless number.
That is the easiest way to get this test wrong.

**Measured (darwin/arm64, `file://` replicas, N = 20/50/200/500/1000):**

    RSS ≈ 65 MB + 0.268 MB per database

The marginal cost **falls** as N grows (0.450 → 0.411 → 0.293 → 0.222 MB/db).
No knee up to 1000; the curve is sub-linear.

### Measured for real on linux/arm64 (EC2, 2026-08-24) — the numbers that count

`scripts/loadtest-ec2-userdata.sh` on a disposable r7g.xlarge, litestream alone,
production cadence, empty WAL databases:

| N | RSS (`file://`) | marginal MB/db |
|---|---|---|
| 500 | 209.9 MB | — |
| 1000 | 364.6 MB | 0.309 |
| 2500 | 907.5 MB | 0.362 |
| 5000 | 1842.6 MB | 0.374 |
| 10000 | **litestream did not survive** | — |

    RSS ≈ 10 MB + 0.365 MB per database        (file://)
    S3 backend costs +0.106 MB per database    (+25%, measured at N=500)
    → the production slope is ~0.47 MB per database

**Ceilings with the S3 backend:** t4g.micro (current) ≈ **1170 apps**, t4g.small
≈ 4000, t4g.medium ≈ 8260. A 10 000-app target therefore fits on **no instance
of this family** — the first hard number saying VM sharding is not optional.

Two open items from that run, both harness faults now fixed in the script:
**litestream died at 10000 databases** and the reason is unknown because only
the shell trace was uploaded, not litestream's own log, and the instance then
destroyed itself with the evidence (memory was NOT the constraint — 31 GB free;
file descriptors are the leading hypothesis). And **the S3 tier at 2500 never
plateaued** (2.2 GB → 0.8 GB across 75s), so the +25% figure rests on N=500 alone.

⚠ **The macOS trend was an artifact.** There the marginal cost appeared to FALL
with N; on linux/arm64 it rises. Small N on the wrong platform inverted the
sign of the very thing being measured.

⚠ **This corrected an earlier projection, and the mistake is worth remembering.**
The 2026-08-24 prod reading (56.9 MB for 61 databases) was divided to give
"0.93 MB per database" — but most of that is a **fixed baseline litestream pays
once, not 61 times**. Dividing a total by a count, when the total has a large
constant term, overstates the marginal cost by ~3.4×. The resulting projection
(9.3 GB at 10k apps, a wall at 250-600 apps) was far too pessimistic; the model
above gives ~2.7 GB and roughly 2000 apps of headroom on the default instance.

Still open, and why the harness takes `--replica s3://`: this was measured with
`file://` replicas on macOS. The **S3 client may hold per-database state that the
file backend does not**, so the real slope could be higher. Restore *timing* from
a local run transfers to nothing — 2-5 ms/app here against ~1150 ms/app in prod,
which is S3 latency, not work.

## Connector-track interfaces (implemented)

- `GET /stats?org_id&app_id → {dbSizeBytes}` — capability-gated usage endpoint; the connector's
  `get-usage-report` calls it. Counts db + WAL (reporting); the quota counts the db file only
  (invariant 10) — the two numbers differ on purpose.
- **Org db quota** — reads `maxDbMb` off the registry's `sk='org'` row (written by the connector
  when it refreshes org-info from dilaya.eu; no new IAM, same table as the app rows) and refuses
  `/query` + `/batch-execute` writes past it with `DB_QUOTA_EXCEEDED` (429). This closes the last
  hole in the caps: a per-app Lambda writes here DIRECTLY with its own capability token, so the
  connector's own enforcement never sees those statements.
- `POST /admin/delete-app {org_id, app_id}` — drop-schema teardown: close executor, drop from
  litestream config, delete the local file, **KEEP the S3 replica**. Capability-gated but skips
  the active-status check (the connector flips the registry row to `deleting` first); the
  connector's `drop-schema` calls it.
