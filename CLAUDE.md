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

## Per-app write recency (2026-08-24, `service/src/write-stats.ts`)

The number every remaining optimisation waits on: the eviction threshold, which
apps belong on a slow-cadence litestream process, and the anti-abuse creation
limit all need the **distribution** of write-idleness per app — not its average.

**Why it could not be read from the replica bucket.** Every VM roll makes
litestream snapshot each database, stamping a fresh L0 file and flooring the
signal at "last boot". On 2026-08-24 four rolls in one day erased it four times:
58 of 61 apps showed a last write inside the same two-minute window, twenty-five
minutes after a deploy. Waiting for a quiet week is betting against our own
release rhythm.

**The VM is the only place this can be counted.** A per-app frontend Lambda
writes to the Data API directly with its own capability token, so the connector
never sees those statements — they all land here.

Three constraints, in order:

1. **It sits on the write path, so it must never be able to fail a customer's
   write.** The hot path is a single `Map.set` — no I/O, no await, nothing that
   can throw. Persistence runs on a background timer
   (`WRITE_STATS_FLUSH_MS`, default 5 min); a failed flush costs resolution,
   never data, and the entry stays pending for the next one.
2. **It must survive instance replacement** — the exact thing the S3 timestamps
   did not. Seeded from DynamoDB at boot; a clean shutdown flushes first.
3. **It must not widen what the data plane can reach.** Rows live in a fixed
   **`_writestats` partition** of the registry table (the `_hosts`/`_catalog`
   trick — org ids are UUIDs, so the literal cannot collide), and the instance
   role's grant is `UpdateItem` **conditioned on `dynamodb:LeadingKeys`**. The
   VM still cannot touch a single org or app row — which matters, because the
   registry is what the double control reads. `test/stack.test.ts` pins that
   condition.

**"A write" means the statement CHANGED the database** (`info.changes > 0`) —
deliberately the same definition litestream reacts to. A statement touching zero
rows produces no LTX and costs no replication, so counting it would measure
something other than what we are pricing.

Only entries that **moved** are flushed, so the write cost follows real activity
rather than the number of apps hosted.

## An app that has never been written is NOT replicated (2026-08-24)

`AppSync` keeps two sets: **`served`** (can answer queries) and **`replicated`**
(a SUBSET — what litestream actually watches, i.e. what `buildConfig` is given).

`restoreIfMissing` already reported `"existing" | "restored" | "fresh"`, and all
three callers threw the value away. `"fresh"` means **no replica exists**, i.e.
nobody ever wrote to this database. Such an app is now served but left OUT of the
config: no timer set, no LIST on every tick, **no OS thread**, no ~0.46 MB of RSS.

**Why this is safe, and why it is NOT the same as evicting an idle app:** a
`fresh` app holds **no data**. There is nothing to lose by not replicating it.
Evicting an app that HAS data is a separate, genuinely risky design (a write
arriving on an unreplicated app would be acknowledged and lost) — that one is
still unbuilt on purpose.

**The promotion gate.** `ensureServed` promotes on first touch, and
`server.ts authorize()` calls it **before any statement runs** on every data
route — so no acknowledged write can precede replication. Promotion does NOT
re-restore (the local file is already the truth; restoring over it is exactly the
stale-data trap invariant 2 forbids), it only adds the app to the config and
bounces. A failed promotion rolls back only what it added, so an already-serving
app never stops serving because a bounce failed.

Consequence, which is the point: **an app created and never touched costs
nothing at all** — no euros, no memory, no threads. That closes the abuse vector
(10 000 empty apps are free) and pushes back the per-process thread ceiling.

`ReplicatedApps` is published beside `ServedApps`; the **gap between them is the
saving**, so it has to be visible. `boot-restore-complete` also carries
`replicated` and `unusedSkipped`.

⚠ An app that is only ever READ is promoted too — the gate is deliberately
conservative. Classifying SQL to promote on writes only would make a
misclassification a data-loss bug; over-promoting merely costs a few timers.

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

### ⚠ The real ceiling is the Go runtime's 10 000-thread limit, not memory

Confirmed twice on linux/arm64 (2026-08-24, runs 1 and 2). At **10 000 databases**
litestream does not start — it dies during boot with:

```
runtime: program exceeds 10000-thread limit
fatal error: thread exhaustion
```

30 019 goroutines at that point. **5 000 databases run fine** (1.85 GB RSS,
30 006 fds), so the wall sits between 5 000 and 10 000 per process.

**The threshold was then bisected (2026-08-24, run 3) and it depends on the
BACKEND — the opposite way round from what was predicted.** S3 was expected to
hit the wall sooner because it is slower; it hits it LATER. At the same 7 500
databases the file backend holds **1.27× more threads** (8 929 vs 7 014) and
**4.8× more file descriptors** (45 006 vs 9 313). The likely reason: the S3
client multiplexes over a bounded HTTP connection pool, while the file backend
does direct blocking I/O — one thread per operation in flight.

Measured on **S3, the production backend** (all survive):

| databases | OS threads | threads/db |
|---|---|---|
| 6 000 | 5 984 | 0.997 |
| 7 500 | 7 014 | 0.935 |
| 8 750 | 8 311 | 0.950 |
| 9 000 | 8 448 | 0.939 |

    threads ≈ 847 + 0.844 × databases     →  10 000 threads at ~10 800 databases

That model also explains the run-2 crash exactly: on `file://` at 1.191
threads/db, 10 000 databases need ~11 900 threads (over the ceiling → crash),
whereas the same count on S3 would need ~9 300 (under it).

**Operational recommendation: 5 000 apps per VM — half the measured threshold.**
Not a round number for its own sake:

1. **The measurement is steady-state, the crash is a startup event.** Every
   database opens at once at boot and the thread count peaks higher than what a
   sample ten minutes later shows. The apparent margin is thinner than it looks.
2. **The test databases are empty.** A database being written holds operations
   in flight, hence threads. Today's fleet is nearly inert; the target fleet is
   not.
3. **This wall gives no warning** — no degradation, no slowdown. The process
   simply stops starting, and all replication halts at once. A ceiling that
   falls without notice deserves more margin than one that creaks.

⚠ RSS samples from run 3 are **not plateaus** (1.5-7.8 GB swings at the same
tier — the 600 s settle is not enough for an S3 upload burst at these counts),
so the memory figures above come from run 2's `file://` tiers, not this one.

Three properties that matter more than the number:

1. **It is a crash, not degradation.** When it goes, replication stops for
   EVERY database at once.
2. **It is not tunable from outside.** Not a ulimit, not a sysctl — Go's
   `debug.SetMaxThreads` default, set in-process. Raising the fd limit to
   200 000 changed nothing (that was the first, wrong, hypothesis).
3. **Production will hit it EARLIER than this test did.** These tiers used
   `file://` replicas; S3 is slower, so more syscalls block concurrently and
   more OS threads are held. The threshold with an S3 backend is likely below
   10 000.

So splitting across processes/VMs is not an optimisation — it is the only way
past a few thousand apps, and the failure mode is abrupt.

### Measured for real on linux/arm64 (EC2, 2026-08-24) — the numbers that count

`scripts/loadtest-ec2-userdata.sh` on a disposable r7g.xlarge, litestream alone,
production cadence, empty WAL databases:

| N | RSS (`file://`) | marginal MB/db | RSS (S3) | S3 overhead |
|---|---|---|---|---|
| 500 | 215.9 MB | — | 276.4 MB | +0.121 MB/db (+28%) |
| 1000 | 403.9 MB | 0.376 | | |
| 2500 | 954.9 MB | 0.367 | 1122.3 MB | +0.067 MB/db (+18%) |
| 5000 | 1848.0 MB | 0.357 | | |
| 10000 | **thread exhaustion** | — | | |

    RSS ≈ 40 MB + 0.362 MB per database     (file://)
    S3 backend costs +0.094 MB per database
    → the production slope is 0.456 MB per database

The marginal cost is **flat** (0.376 / 0.367 / 0.357) — it neither rises nor
falls. Run 1 suggested a rising trend and macOS suggested a falling one; both
were noise on too few points. Two clean plateaus give the S3 overhead twice.

**Memory ceilings with the S3 backend:** t4g.micro (current) ≈ **1140 apps**,
t4g.small ≈ 4070, t4g.medium ≈ 8450. But these are moot — the thread ceiling
above bites first, and it bites as a crash.

Both open items from run 1 are now closed by run 2: the 10 000 failure is
thread exhaustion (above), and the S3 tier plateaued cleanly once the settle
scaled with N.

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
