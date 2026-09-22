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
   **Rewritten 2026-09-19 (`t_vm_zero_cut_handover`) — the invariant is "ONE litestream WRITER",
   not "one instance".** What the rule above protects is the generation path, and an instance that
   only *restores* (reads S3) and has not started `litestream replicate` is not a writer. So with
   `handoverEnabled=true` — and ONLY then — the ASG takes `maxCapacity: 2`,
   `minInstancesInService: 1` and an `EC2_INSTANCE_LAUNCHING` hook: the replacement warms up
   beside the serving instance, invisible (no Cloud Map registration, no replication), and starts
   writing only after the predecessor has REPORTED that its litestream child exited
   (`service/src/handover/`). Three things keep that safe, and each is a test:
   (a) **one switch** reshapes the ASG and enables the protocol — a second parameter would make
   "overlap without protocol" expressible, which is the dual writer (`test/stack/handover.test.ts`);
   (b) the boot **order** — announce → restore → bind → gate → `litestream.start`
   (`test/handover-boot-order.test.ts`); (c) a live predecessor **acknowledges** the replacement,
   so "no report yet" is read as *wait* and never as *nobody is there* (`test/handover-overlap.test.ts`).
   Capacity rebalance stays OFF in both modes: it overlaps instances on AWS's schedule, outside
   any deploy, and buys nothing. `replacingUpdate()` stays forbidden: it creates a second ASG,
   which no hook of ours holds back. The residual risk, stated plainly: a predecessor that
   acknowledged and then HUNG — alive, replicating, unable to report. After
   `handoverOverlapTimeoutMs` the replacement proceeds with an error naming it; by then the rolling
   update has long since terminated that instance, which is what actually stops it.
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
    **Since 0.1.49 (t_quota_db_bypass, audit 22/09) the check is also a CEILING.** The guard used to
    judge the org and then let the statement write whatever it wrote: `WITH … INSERT` rode the
    exempt `WITH` head, a trigger planted under the cap turned an exempt `DELETE` into a write, and
    one `INSERT … SELECT randomblob()` issued under the cap could write gigabytes. Now the guard
    returns the room left (`cap − used`, + `EXEMPT_SLACK_BYTES` = 256 KB for exempt SQL, which is
    ALL an exempt statement gets once the org is over) and the worker turns it into
    `PRAGMA max_page_count` before the statement (`service/src/quota/ceiling.ts`): SQLite answers
    SQLITE_FULL past it, rolls the statement back, and the worker reports `DB_QUOTA_EXCEEDED`. One
    ceiling per transaction and per batch (set by the first statement) — N statements do not add
    up N rooms. `WITH` is exempt only when no INSERT/UPDATE/REPLACE follows;
    `CREATE [UNIQUE] TABLE|INDEX IF NOT EXISTS` (without `AS SELECT`) is exempt, because every
    system table runs it before a READ and refusing it broke reads, deletes and Telegram ingress
    over the cap. Residual, stated: the room is computed from a cached measurement, so concurrent
    statements on different apps of one org can each use it — bounded by the TTL, as before.
    `journal_size_limit` (64 MB) makes a checkpointed WAL shrink back instead of keeping its
    high-water mark.
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
    that touch the production databases are a new service, a bumped pin, and a changed
    `rootVolumeGb` (invariant 13) — all three deliberate.
13. **The root volume size is ours, not the AMI's.** Until 2026-08-25 the launch template carried
    **no `blockDevices` at all**, so the ASG silently inherited the image's own 8 GB root: a number
    nobody chose, live for four months. Same shape as the AMI before it was pinned — a value we
    were subject to rather than one we own, and left implicit a future pin bump could have changed
    the disk size on its own. It now comes from `rootVolumeGb` (default 30 GB, from the sizing law
    in "What an app actually costs on disk"). Two things are load-bearing: the device name **must**
    be the AMI's own root (`/dev/xvda` on AL2023 arm64) — any other name ADDS a volume instead of
    resizing the root, which looks like it worked while the databases stay on 8 GB — and the
    mapping states the **size only**, leaving type/IOPS/throughput/encryption to the snapshot, so
    that a sizing change never rewrites a database machine's root volume as a side effect. Both are
    pinned by `test/stack.test.ts` (each verified to fail without its fix). Changing the value rolls
    the instance, which is also what applies it; nothing to do on the box, since cloud-init runs
    `growpart` and the root is XFS.
14. **The root volume is encrypted, with the AWS-MANAGED key, and that choice is load-bearing.**
    This disk carries the `app.db` of every app of every org. Until 2026-08-25 it was NOT encrypted
    while the S3 replica always has been (`S3_MANAGED`) — so the travelling copy of customer data
    was protected and the original was not. Encryption now comes from `encrypted: true` with
    `kmsKey` left **unset**, which selects the account's `aws/ebs`. Its key policy grants
    `Encrypt`/`GenerateDataKey`/`CreateGrant` to every principal in the account acting
    `ViaService: ec2.<region>.amazonaws.com`, which is exactly what lets the Auto Scaling
    service-linked role launch from it with no extra grant. A **customer-managed key would need
    that grant written by hand**, and getting it wrong degrades nothing — the ASG simply cannot
    launch, which on this singleton is a total outage of every org's databases. That is why no CMK
    parameter is offered, and why a test fails if one appears. Verified empirically before
    shipping: encryption-by-default is OFF account-wide and **no encrypted volume had ever existed
    in this account**, so nothing could be assumed from prior art — a throwaway t4g.micro launched
    from the pinned AMI with an encrypted 30 GB root reached `running`, then was terminated.
    ⚠ It protects the physical medium and any copied snapshot; it does NOT protect against an
    application-level read or a compromised AWS credential.

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
- Release: bump `hereyarc.yaml` version → PR → merge → **GitHub release `v<version>`** (the tag
  must equal the `hereyarc.yaml` version). `.github/workflows/publish.yml` then runs
  `hereya publish` with the org's `HEREYA_TOKEN` — no local Hereya login involved (a local
  `hereya publish` still works as a fallback; a failed publish of the same version is retried via
  the workflow's manual dispatch). `hereya publish` sends metadata only (repository URL, commit,
  sha256 of `git archive HEAD`) — nothing is built in CI; the Hereya executor builds at deploy
  time. **Publishing ≠ deploying**: the package reaches prod only once the connector's
  `hereya.yaml` pin is bumped and a connector release is cut.

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

## The handover AT PROD SCALE (2026-09-19, `t_handover_catchup_parallel`)

Switching the handover on in prod cut the Data API for **227 s**; the trial stack had said ~17 s.
The trial carried five databases, prod carries 100, and **both terms that blew up are per-app
loops on the outage path**. Neither could show on a small fleet:

1. **The catch-up re-restored one app at a time** — 100 apps, 105 s, where the boot restore does
   the same work at 8-wide. It is now a bounded pool (`catchUp`, width =
   `bootRestoreConcurrency`).
2. **The DEPARTING instance never finished its drain.** `Shutdown.begin` asked every served app
   for `PRAGMA wal_checkpoint(TRUNCATE)`, serially. TRUNCATE needs every reader gone and
   litestream holds a read transaction on each database it replicates, so **every call blocked
   its full 5 s and failed** (journal: one `checkpoint-failed` every 5.00 s). 100 apps = 500 s;
   systemd's 90 s stop timeout SIGKILLed the service first — no final sync window, no clean
   `litestream.stop()`, no write-stats flush, **no handover report**. The replacement therefore
   waited for the ASG to drop the instance (the 132 s) and then treated all 100 apps as unknown.
   The step is removed: litestream ships WAL frames and never needed the WAL folded in.
   ⚠ This predates the handover: the step shipped long before it. Consistent with prod — the two
   terminations on record (18/09 and 19/09) both took 122 s, and the 19/09 console shows the OS
   powering off 92 s after the SIGTERM, i.e. systemd's stop timeout. Not proven further back.

Measured on `dilayadev-handover-scale`, **100 seeded apps**, a statement per second as the probe
(`scripts/acceptance/handover-scale.mjs`):

| roll | what it exercises | cut |
|---|---|---|
| old drain → fixed service | the serial checkpoint on the departing side | ~66 s (from the ASG's terminate; the probe started late) |
| fixed → fixed, 30 apps written through the roll | normal regime; catch-up 30 apps in 6.4 s | **19 s** |
| fixed → fixed, ALL 100 apps written through the roll | worst catch-up: 100 apps in 23.1 s | **32 s** |
| instance terminated (no overlap possible) | crash recovery: launch + boot + 15 s wait | 75 s |

Every write the API acknowledged during those rolls was read back afterwards (1536 of 1536 on
the 30-app roll). Two isolated 4 s timeouts followed the 19 s roll — the gateway's target cache,
already seen on the first trial. What remains in the cut is fixed cost: `drainMs` (5 s), the
final sync window (2 s), litestream start and Cloud Map registration.

**The rule this leaves behind: nothing on the drain or the gate may loop `for … await` over the
apps.** `test/shutdown-drain-scale.test.ts` and the concurrency test in
`test/handover-catchup.test.ts` pin both; each was verified to fail first. And a trial stack
that does not carry prod's app count measures nothing — seed it (`handover-scale.mjs seed`).

## A process RESTART is not a handover (2026-09-20, `t_handover_stale_ack_wipe`)

Found by the crash trial of `t_dbmove_p4_move` — live in prod since the handover was switched on
(19/09), and nothing to do with moving databases.

**What happened.** The `_handover/ack` item outlives the roll that wrote it, and names the instance
that goes on serving (`forInstanceId`). When that instance's PROCESS restarted — SIGKILL, OOM,
`systemctl restart`, the SSM emergency path — the boot read the ack of its own first boot:
`predecessor-alive` (a dead instance) → the ASG lists nobody → `predecessor-gone` →
`catchup-start unknown:true` → **every local database deleted and re-restored from S3**. The
catch-up is only safe when "this instance never wrote to these files"; on a restart the disk holds
acknowledged writes no replica has yet. And a crash never leaves Cloud Map, so requests kept
arriving WHILE the files were deleted: a worker re-created an EMPTY file (`SQL_ERROR no such
table`), the restore then failed on it (`output path already exists` → `catchup-failed`), and the
app served an empty database that litestream started replicating. On the trial: 13 acknowledged
writes lost on one app, the service restarting twice. Read-only check on prod the same evening:
its ack named the serving instance.

**Three guards, each with a test verified to fail first:**

1. **The instance remembers that it WAS the writer** (`handover/writer-marker.ts`): a marker on
   the database disk — whose lifetime is exactly the instance's — written once replication has
   started, removed on a clean shutdown AFTER `litestream.stop()` and BEFORE the handover report
   (no removal ⇒ no report). A boot that finds it is nobody's replacement: it announces nothing,
   skips the gate (`gate-skipped`) and starts replicating at once. Nothing in DynamoDB can tell
   a restarted writer from a warming replacement — same instance id, records that outlive the
   process — which is why this is on the disk.
   ⚠️ NOT "the files pre-existed": a REPLACEMENT whose process crashed while warming also finds
   its files, and those ARE stale reads — it must go through the gate and the catch-up.
2. **An ack is addressed to a BOOT, not just an instance** (`ack.ts`): it echoes the `atMs` of the
   announcement it answers, compared for equality (never as a time). An ack from a predecessor
   that predates this carries none and reads as "no ack" — the ASG listing covers that roll.
3. **`catchUp` refuses a file that was on the disk when this boot began** (`predatesBoot`,
   from the boot restore's `existing`), whatever the gate concluded: the safety condition of
   that file, checked instead of assumed.

**Tried for real** (`dilayadev-move-trial`, handover ON, 100 seeded apps,
`scripts/acceptance/restart-under-write.mjs`): production's ack item planted verbatim for the
serving instance, three apps written every 100 ms, `kill -9` of the process. Before the fix
(same stack, same evening): `catchup-start apps:20 unknown:true`, `SQL_ERROR`, `catchup-failed`,
acknowledged rows gone. After: **363 acknowledged writes, 0 lost**, journal `gate-skipped` and no
`catchup-start`, API back 5.6 s after the kill.

**Known and left as is:** a restarted process that is NOT a marked writer (a replacement that
crashed while warming, or a clean `systemctl restart`, which releases the marker) still serves
without replication for the ack wait + the short wait (~25 s) — the stale Cloud Map registration
routes to it. Those writes are on the local disk and litestream ships them when it starts.

## Placement: a CELL holds an app, not "the VM" (2026-09-20, `t_dbmove_p2_placement`)

Phase 2 of the live-moves plan. **Nothing production can observe changes**: there is still one
cell and it still holds everything. What changes is that this is now a FACT READ FROM A TABLE
instead of an assumption welded into four places.

- **A cell** = one serving VM + its replacement slot. `CELL_ID` (the stack sets `"0"`, the
  origin). Keyed by cell and never by instance id: an instance id changes at every roll, and
  rewriting 100 placements per deploy would put a per-app loop back on the outage path.
- **Rows**: registry table, partition `_placement`, `sk = <orgId>/<appId>` →
  `{vmId, version, phase, targetVm}`. **No row = the origin cell** — no migration, and an empty
  partition (today) is exactly the old behaviour. Phase 2 only READS `vmId`; nothing writes yet,
  so the instance role gained nothing (`RegistryRead` already covers `Query`).
- **`PlacedRegistry`** (`service/src/placement.ts`) wraps the ddb registry so `listActive` only
  lists this cell's apps. Below every caller on purpose: `doSync` DELETES the local file of any
  served app missing from that list, so an unfiltered second cell would wipe a moved database at
  its first reconcile. One strongly consistent `Query` of the partition per `REGISTRY_CACHE_MS`,
  shared by a burst; **an unreadable placement throws** — "mine" would start a second litestream
  writer, "not mine" would make the reconcile delete files this cell alone holds. Errors are never
  cached, and a row without `vmId` is refused rather than read as the origin.
- **The gate answers `421 MISPLACED`** for an active app held elsewhere, BEFORE `ensureServed`:
  restoring it here is the dual writer. (Phase 3 turns the 421 into a VM→VM relay; no client
  ever sees it while there is one cell.)
- **Cloud Map: "clear MY cell's leftovers"**, no longer "deregister everyone". Registrations carry
  `DILAYA_CELL`; one without it predates this and counts as the origin's, so the roll that ships
  this behaves exactly like the previous ones.
- **Per-app hold** — `Limiter.hold(appKey, maxMs)` / `admit(appKey)`. Every data route calls
  `admit` where it called `acquire`. It is NOT grafted on `ensureServed`'s `pending` as first
  sketched: between `authorize` and the slot there is an `await` (the quota), i.e. the very gap
  eviction covers with a 5-minute grace. In `admit` there is no await between the wake-up and the
  slot, so once `hold` returns a statement is either counted by `inFlight` or parked — a mover
  drains by watching `inFlight` reach 0. Holds reads too (a route cannot tell before running),
  expires on its own (≤ 10 s, `hold-expired`), and `release()` returns **false** when it had
  expired: what ran under it was not exclusive, the caller must abort. No caller yet (phase 4).

- **A row without `vmId` costs ONE app, not the cell**: that app answers 503 and is held by
  nobody (its replica stays in S3); everything else keeps serving. The first draft threw on the
  whole read — one malformed row would then have aborted the BOOT of every org's databases.
  Stored as `null`, and read with `has`, not `??`: `null ?? ORIGIN` quietly handed the app back
  to the origin (caught by its test).

**Tried for real** (trial stack `dilayadev-placement-trial`, 100 seeded apps, destroyed the same
hour — `scripts/acceptance/placement-trial.mjs`, 8/8): the boot survives the consistent `Query`
with the role as it is (100 apps restored in 13.6 s at 8-wide); Cloud Map accepts the custom
attribute on the DNS-backed service, and the roll left ONE registration; a row placing an app on
cell 1 → `/admin/sync` `{removed: 1}`, the app answers 421, its neighbour never notices; an
ownerless row → that app 503, neighbour 200; row deleted → `{added: 1}`, restored from S3 with the
write acknowledged before it left.

Deliberately NOT here, moved to phase 3 where two real cells can test them: per-cell handover
record keys, per-cell heartbeat/metric dimensions and alarms, the `_vms` partition and its grant.
With one cell each of them would be code no test and no trial could exercise.

## N cells, one gateway: the VM→VM relay (2026-09-20, `t_dbmove_p3_relay_cells`)

Phase 3. `vmCount` (default **1** = the stack exactly as it was) adds cells. A cell owns what the
single-writer invariant is scoped by — its ASG, its launch hook, its `CELL_ID`, its four alarms —
and SHARES everything a client can see: one gateway, one Cloud Map service, one SG, one role, one
table, one bucket. **The 5 Data API clients, the app Lambdas' IAM and env do not change.**

- **The relay** (`service/src/relay.ts`, `server/relay-out.ts`). The gateway knows nothing about
  apps, so a request lands on any cell. The gate's `MISPLACED` is caught in `build.ts` and the
  request is forwarded — method, path, body, capability header — to the holder on the private
  network; the answer goes back **verbatim**. The capability gate runs BEFORE, on both cells.
  Two rules carry the safety:
  1. **A relayed request is never relayed again** (`x-dilaya-relayed`). A cell that does not hold
     it answers 421 to the peer. Diverging caches cost one hop, never a loop. Before answering 421
     to a peer a cell RE-READS placement, so that a 421 between VMs always means "as of now" — the
     relaying cell then re-reads its own and tries once more.
  2. **What the client is told must be true of what ran**, because its retry policy acts on it
     (`dilaya-connector/src/dataapi-retry.ts` replays a write on 503). `UNAVAILABLE` (503) only
     when the TCP connection was **never established** — judged from the socket's `connect`
     event, not from an error-code list: a dead instance sends no RST, it just never answers
     the SYN (2 s connect timeout). Anything after the connect may have run → `INTERNAL` (500
     with a code), which no client replays.
- **`_vms`** (`vms.ts`): `sk = <cellId>/<instanceId>` → `{ip, port, state, beat, atMs}`, written
  by each instance when it enters Cloud Map, `retired` at drain step 0. Grant: `PutItem` +
  `DeleteItem` conditioned on `LeadingKeys = _vms`. **The announcement is never fatal**: with one
  cell nobody reads the row, and aborting a boot over it would be a total outage.
- **Peer watch** (`peer-watch.ts`, 20 s). A crashed instance never deregisters, and with N cells
  1/N of ALL traffic would hit its address until its replacement boots. A peer evicts it from
  Cloud Map once its `beat` counter has stood still for 3 of the WATCHER's own ticks — **no clock
  of another machine is read**, and a tick the watcher could not read counts for nothing. A wrong
  eviction heals itself: the victim finds `evicted` on its row and registers again; meanwhile it
  stayed reachable through the relay.
- **Placing a NEW org**: an ORG row `_placement / sk=<orgId>` → `vmId`. Resolution: the app's
  row, else its org's, else the origin. Read-only for the VMs (the write grant on `_placement`
  comes with phase 4). ⚠️ **Only for an org with no database yet**: a row says where the file IS,
  it moves nothing. `/admin/delete-app` and `/stats` follow placement too (`assertHeldHere` — the
  delete route has no `authorize()`, and "deleted" from a cell that never had the file would
  leave the real one behind).
- **Per cell, with the origin unchanged**: handover keys (`handover/keys.ts`: `current#1`…; the
  origin keeps the bare keys — the roll that ships this has an old instance on one side) and
  metric dimensions (`metric-dimensions.ts`: `{stack, cell}`; the origin keeps `{stack}`, because a
  new dimension set is a NEW metric and would orphan every alarm for the length of a roll).
- ⚠️ **Lowering `vmCount` destroys the cells above it.** Their data survives in S3 but nothing
  re-places it: empty a cell before removing it (phase 4/5 tooling).
- **`/admin/sync` is BROADCAST to every cell** (`Relay.broadcast`, never re-broadcast; the answer
  carries `cells: [{cellId, instanceId, status}]`). The first draft said "reaches one cell,
  harmless" — the trial proved it wrong, see below. The rule for an operator: **placement row →
  `/admin/sync` → only then the org's first database.** Without the sync, a cell keeps its
  placement cache for `REGISTRY_CACHE_MS` (30 s) and still believes it is the holder.

**Tried for real** (trial stack `dilayadev-cells-trial`, `vmCount=2`, handover on, 100 seeded apps
on the origin + 10 in an org placed on cell 1, destroyed the same hour —
`scripts/acceptance/cells-trial.mjs <stack> kill`, 15/15):

- The joints hold: one Cloud Map registration per cell, both `_vms` rows written with the role as
  it is, the SG lets one VM reach the other, and **the gateway does spread over both
  registrations** — the relay ran both ways (509 / 305 requests), none crossed twice. 400 reads
  over both orgs all correct, client-side p50 112 ms / p95 153 ms (SigV4 + gateway included, about half of them relayed;
  no one-cell baseline was taken in the same run, so the hop's cost is NOT isolated here).
- **The defect no test could see.** First run: org row written, `/admin/sync`, 10 apps created —
  2 of the 10 answered `no such table`. The sync had reached ONE cell; the other still believed
  "no row = mine", so it CREATED the database at home, and the next statement landed on the real
  holder. Silent-loss shaped (an acknowledged `CREATE TABLE` on a file the reconcile then
  deletes). Hence the broadcast; re-run on a FRESH org: 10/10 born on cell 1, none on cell 0.
- **A crash, not a terminate.** `ec2 terminate-instances` is a clean shutdown: the service drains,
  deregisters and retires its row — the origin's org saw 3 errors in 10 s and nobody had anything
  to evict. With an immediate power-off (sysrq `o`): **cell 0 evicted its dead peer after 44 s**;
  until then the ORIGIN's org — whose cell was perfectly healthy — lost 8 of its ~44 one-per-second probes (the
  gateway kept sending 1/N to the dead address), and none after. Cell 1 was back on a new
  instance, restored from S3 with its data, **83 s** after the crash, and cleared its cell's
  leftovers from `_vms` (2 rows, not 3).
- **A roll of ANY cell is felt by EVERY org.** Both cells rolled one after the other (handover
  on): each org saw scattered 4–8 s gaps during BOTH rolls (~16–23 s of failed probe-seconds
  in a 40 s window, against 19 s for one cell alone) — the gateway's target cache again, now
  paid once per cell. The connector's retry covers it as before, but N cells do not make a roll
  cheaper for anyone; that is phase 5's job (drain a cell instead of rolling it).

## Moving one database to another cell (2026-09-20, `t_dbmove_p4_move`)

Phase 4. `POST /admin/move-app {org_id, app_id, to_cell, force?}` — asked of ANY cell (a cell that
does not hold the app answers MISPLACED, and the relay carries it to the holder). Prod still has
one cell: nothing can be moved there yet, and nothing production can observe changes.

**The protocol, and who writes what** (`service/src/move/`):

| step | who | what |
|---|---|---|
| `begin` → row `moving` | A (`mover.ts`) | intent; `version+1` = this move's id |
| hold + drain | A | `Limiter.hold` parks new statements, `close("departing")`; waits for `inFlight = 0`, no promotion `pending`, no open tx — else ABORT |
| detach | A (`sync/depart.ts`) | close the worker FIRST, then `litestream sync -wait` + `stop` + `unregister` — **observed, no bounce fallback** (`Litestream.detachOne`) |
| row `a_stopped` | A | a REPORT of that fact, by the one that observed it |
| `/admin/move-in` (cell to cell only, not a gateway route) | A → B | |
| clear the local copy, then **claim** → row `b_started` | B (`arrival.ts`) | clear BEFORE claim; claim BEFORE restore |
| `ensureServed` (restore from S3 + `register`) → `finalize` (`vmId=B`, `version+1`) | B | the ordinary hot-add path |
| **read the row** → `moved` / `resumed` | A | set the files aside under `<dbDir>/_moved/` for `MOVE_KEEP_MS` (1 h), or re-replicate (a bounce) and reopen |

**The safety rule is two conditional writes, not a convention** (`move/record.ts`): `cancel`
(condition: phase ∈ {moving, a_stopped}) and `claim` (condition: phase = a_stopped AND targetVm =
me) are on the same row, so exactly one wins. Before `b_started` a move can only go back to A;
from `b_started` on it can only finish on B. **No timer decides** — a timer only decides to TRY.
`placement.ts` reads `b_started` as "held by `targetVm`", so a replacement instance booting
mid-move on either side agrees without anyone finishing the move first.

Two rules on A, each with a test verified to fail first:

1. **The outcome is READ, never assumed.** Whatever B answered — 200, 500, nothing — A decides
   from a strongly consistent read of the row. A lost answer after B claimed is "moved".
2. **Until the outcome is known the app is CLOSED on A** (503 = "nothing ran", which the
   connector replays). The hold parks statements ≤ `MAX_HOLD_MS` (10 s); past it they are
   REFUSED, not run — litestream has let go of the file, a statement that ran would be
   acknowledged and lost. If the row cannot be read, the app stays closed: correct, nobody knows
   who holds it.

**Three traps found while writing it** (each pinned):

- **A departing app STAYS in `served`.** `doSync` restores and REGISTERS any active app of the
  cell that it does not find there — and until B claims, placement says the app is ours. Taking
  it out of `served` hands it back to litestream at the next poll (`depart.test.ts`).
- **The gate parks BEFORE `ensureServed`, and re-checks synchronously after reading placement**
  (`server/gate.ts`): a promotion is the other path that registers a database. One that started
  before the hold is visible in `pending`, and the mover drains it like a statement.
- **B clears its local copy BEFORE the claim.** After the claim relayed statements arrive at
  once, and `restoreIfMissing` keeps an "existing" file as is — a copy from an earlier stay
  would be served as current data. It refuses when it SERVES the app (then the file is live).

An open transaction lives in A's memory and cannot follow the file: it is waited for WITHOUT a
hold (under one its COMMIT would park), then the move gives up with **409 `MOVE_ABORTED`**,
nothing written. A database above `MOVE_MAX_BYTES` (64 MB) is refused unless `force`: B's
restore would outlast the hold (measured in phase 0: ~1.3 s small, the 500 MB one far longer),
and its statements would see 503s until B is ready. Pre-warming B in follow mode
(`restore -f`, 7.9 s pause at 500 MB in phase 0) is NOT built.

**Orphaned moves** (`move/sweep.ts`): at boot BEFORE the restore, then on each registry poll, a
cell cancels its own moves that no live process drives (if B claimed first the write fails and
the app is B's) and finalizes the ones it claimed. IAM: `PlacementMoves` = `UpdateItem` on
`LeadingKeys = _placement`, nothing else — a conditional partial update is the whole API.

⚠️ **Every cell must run ≥ 0.1.46 before any move**: an older B has no `/admin/move-in` (the
move is cancelled — harmless), but an older cell reads `vmId` only and would not see
`b_started`. ⚠️ A cell whose PROCESS restarted after an app left keeps that app's file on disk
(unserved, unwatched, still counted by the org quota) until the instance is replaced or the app
comes back; `clearForArrival` is what makes that harmless.

**Tried for real** (trial stack `dilayadev-move-trial`, `vmCount=2`, 100 seeded apps, destroyed
the same evening — `scripts/acceptance/move-trial.mjs <stack> crash`, **36/36** on the final run,
handover ON, i.e. production's configuration):

- **40 moves under load over four runs** (a writer every ~100 ms on the moved app, five bystanders
  throughout): pause **1.2–1.5 s** server-side, longest client silence 1.3–1.7 s, **0 acknowledged
  write lost**, bystanders' longest silence 0.5–0.8 s and nothing refused them by the service. The
  role really may `UpdateItem` `_placement`; the target really continues the same replica path
  (a restore from S3 that touches no service returns every row). Back again to the cell it left:
  same — the stale copy is wiped before the claim.
- **Two defects the first run found, neither visible to a test then** (both now pinned):
  a statement that entered through the TARGET cell, was relayed to the source and parked there,
  came back as a 421 once the app had arrived — and was answered **503** instead of served (6 of
  10 moves showed the client one error; `ServeHere` in `relay-out.ts`); and the registry poll,
  landing between B's claim and A's read, deleted the file the mover was about to set aside
  (`doSync` now leaves a departing app alone).
- **A SIGKILL at each of the 7 steps** (4 on A, 3 on B), writer running through it: every time ONE
  cell holds the app, ONE litestream watches it, every acknowledged row is read back, S3 agrees
  with what is served, and no row is left mid-move after one sweep. Before `b_started` the app
  is back on A; from `b_started` on it is on B — including when the process that claimed it died
  before restoring anything. The app is unreachable for the 16–21 s its crashed cell takes to
  restart (that is crash recovery, not the move).
- ⚠️ The first crash run LOST acknowledged writes — and the move was not the cause: the handover
  was (see "A process RESTART is not a handover"). Re-run with the handover off: 7/7; then with
  the fix and the handover on: 7/7.
- What a client may see while a CELL dies mid-move: gateway 503s (no `error.code`), `503
  UNAVAILABLE` (nothing ran — replayed by the connector), and at most one `500 INTERNAL` for the
  statement that was on the wire to the dying cell (may have run — not replayed). By design.

`MOVE_CRASH_POINTS=on` (set by NO stack; the trial adds a systemd drop-in) lets a request name
a step at which the process SIGKILLs itself (`move/crash-points.ts`) — how "a crash at every
step" is tried for real: `scripts/acceptance/move-trial.mjs <stack> crash`.

## Emptying a cell: the drain (2026-09-21, `t_dbmove_p5_drain_ops`)

Phase 5. `POST /admin/drain-cell {cell, action:"start", to_cell, big?, leave?}` / `{cell, action:"stop"}`
and `POST /admin/drain-status {cell?}` — gateway routes, answered by ANY cell: an order names no app,
so it has no holder. Prod still has one cell; with one cell the only thing that changes is one
consistent `GetItem` per registry poll and the `ReplicationLagMaxSeconds` series.

- **An order is an INTENT, a row — never a fact about where a database is.** `_vms / drain#<cell>`
  (written by the route) and `_vms / drainstate#<cell>` (written by the draining cell): two rows
  because the partition only has whole-row `PutItem`/`DeleteItem`, so ONE writer per row is what
  keeps a progress report from undoing an operator's "stop". No new IAM; `vms.ts` ignores both.
- **The DRAINING cell drives its own drain** (`service/src/drain/drainer.ts`), not the target as the
  study sketched: the mover, the file sizes and the open transactions are all there, and a
  replacement instance booting mid-drain reads the order and carries on. It only ever ASKS
  `Mover.moveOut`, app by app — the two conditional writes of `move/record.ts` remain the whole
  safety rule. One look at the order per registry poll, and at once on `/admin/sync` (which the
  route broadcasts).
- **No serial loop**: `bootRestoreConcurrency` (8) moves at a time, smallest database first.
- **A failed move is NOT free** — its app was paused, then resumed. So: no pass at all unless the
  target has a serving instance; a pass stops after 3 failures in a row; and the next passes are
  spaced out (2, 4, … 16 polls). A timer only decides to TRY again. A move refused before anything
  was written (open transaction — 409 `MOVE_ABORTED`) paused nobody and does not count.
- **`big`**: `skip` (default) leaves any database above `MOVE_MAX_BYTES` where it is and reports it
  (`skippedBig`, state `blocked`): such a cell is NOT empty, stays in Cloud Map, and its roll is
  the ordinary handover for what remains. `force` moves it like the others (long pause).
- **Once empty, the cell LEAVES Cloud Map** (`leave`, default true) — this is what the whole plan
  was for. The cuts measured in phase 3 came from the gateway still targeting an instance that
  was going away; a cell that left discovery minutes earlier can be replaced and nobody notices.
  It stays reachable through the relay (its `_vms` row says `serving`).
  - **Its replacement stays out too**: at boot step 6, a cell that holds nothing and finds an
    order with `leave` does not register. Unreadable order = it registers (in discovery a cell can
    always relay: walking in is the answer that cannot hurt).
  - A peer that wrongly evicted it does not walk it back in (`boot/cells.ts`).
  - **The order stays in force until lifted.** An app born meanwhile on a drained ORIGIN (no row =
    the origin) is moved at the next poll. Lifting the order (`stop`) is what re-registers.
  - An unreadable order is no judgement: no move, no leave, no re-entry.
  - ⚠️ **Out of Cloud Map is NOT out of the gateway.** The VPC link keeps its targets for a while:
    on the trial stack requests still reached the cell ~10–25 s after it had deregistered, and
    an instance replaced in that window showed clients its shutdown 503s. The cell measures it
    itself: `progress.gatewayQuietMs` = ms since the last request that came THROUGH the gateway
    (not relayed), on its own clock. **Replace the instance only once it is past ~2 minutes.**
- `start` is refused when the target is itself being drained (two cells passing the same
  databases back and forth, one pause each time), or when either cell has no serving instance.

**Rolling the OS without a cut** — `amiIdByCell` ("0=ami-old") holds the named cells on an image
while the others take `amiId`/the pin. A launch-template change rolls ITS cell at the deploy that
carries it; one image for all would roll every cell at once, databases on board. The procedure,
from one cell: (1) bump the pin, deploy with `vmCount=2` and `amiIdByCell=0=<old>` — cell 1 is born
on the new image, cell 0 does not move; (2) drain 0 → 1, wait for `empty`, `inCloudMap: false` AND `gatewayQuietMs` ≥ 120 000;
(3) deploy without `amiIdByCell` — cell 0 rolls, empty and unseen; (4) `stop` the order, drain
1 → 0, `stop`; (5) deploy with `vmCount=1`. Drop the override when done: `check:ami` reads the pin.

- **A progress report only speaks for the order it names** (`orderedAtMs`): it outlives its order,
  and the first real run read the "empty" of the PREVIOUS drain as the answer to one ordered a
  second earlier. `drain-status` shows no progress until the cell has looked at the current order.

**Tried for real** (trial stack `dilayadev-drain-trial`, `vmCount=2`, handover on, 100 seeded apps,
destroyed the same night — `scripts/acceptance/drain-trial.mjs`):

- **100 databases emptied in 19–27 s, five full drains over three runs, both ways** (one pass, 8
  at a time, on t4g.micro): 0 failed move, 0 row left mid-move, **0 acknowledged write lost** on
  five apps written every 100 ms through it, nothing refused by the service. Longest client
  silence 1.9–2.8 s, 4.2 s once (against ~1.3 s for a move alone in phase 4: eight restores share
  one small VM). **21/21 on the final run.** The way
  back returns every app to a cell that still held an older copy of it (`clearForArrival`).
- The role really may write both rows in `_vms`; any cell answers the routes; the reverse order
  is refused while the first stands.
- The emptied cell left Cloud Map; an app born meanwhile on the drained origin (through the
  relay) was on the other cell within a poll, its row intact.
- **Replacing the emptied cell's instance, once `gatewayQuietMs` ≥ 90 s (twice): no VM refused
  any client, longest silence 0.55 s** over ~3 000 writes on three apps each time. The FIRST run
  replaced it ~25 s after the cell had left Cloud Map and clients saw four of its shutdown 503s —
  which is how `gatewayQuietMs` came to exist — against scattered 4–8 s gaps
  for every org when a cell is rolled with its databases on board (phase 3). The replacement
  stayed out of Cloud Map; lifting the order brought it back within a poll.
- `ReplicationLagMaxSeconds` on S3: published by both cells, **max 2.9 s with ~100 idle
  databases** — `last_sync_at` does advance without writes on S3 too, so the alarm will not fire
  on a quiet night.
- Background of that stack, before any drain: ~1 gateway-only 503 per 400–600 requests under
  concurrent load (`integrationLatency: 0`, no `error.code` — the connector replays those).
- ⚠️ Found on the way, NOT a drain defect (`t_worker_evict_inflight_503`, fixed in 0.1.48 — see
  "A worker is only used under a LEASE"): 100 reads in parallel on 100 apps → ~9 × `503 "app is
  shutting down"`.

- **"stop" means stop**: an order lifted 4 s into a drain left 75 apps where they were, 26 moved,
  no row mid-move. (The second run's pass had moved all 86 queued apps AFTER the stop — a running
  pass now re-reads its order when poked, and the route pokes.)

**Three series, three alarms** (`service/src/cell-gauges.ts`, `lib/stack/alarms/moves.ts`), all
published by the heartbeat under the cell's dimensions, none breaching on silence:

- `ReplicationLagMaxSeconds` (every cell, origin included) — the worst "now − `last_sync_at`"
  among the databases litestream watches (`litestream list -json` on the control socket). Tried on
  0.5.17: the stamp advances every sync interval even when nothing was written, and STANDS STILL
  while the replica cannot be written — so an idle database has no lag, and this is the failure
  neither the heartbeat (litestream is running) nor the capacity alarms can see. Alarm above
  `replicationLagAlarmSeconds` (300), 3 of 5.
- `MovesStuck` (several cells only) — moves naming this cell seen in ≥ 4 consecutive sweeps with
  the same version (`move/stuck.ts`). Counted in OUR sweeps: a row has no timestamp, on purpose.
- `RelayedRequests` / `RelayFailures` per tick. Only the FAILURES are alarmed (> 20 in 5 min,
  twice): with N cells (N−1)/N of the traffic is relayed by design, so the rate is a fact about
  the gateway's spread, not a fault.

## A worker is only used under a LEASE (2026-09-21, `t_worker_evict_inflight_503`)

`MAX_LIVE_WORKERS` is 8 (a child process per app, on a 916 MB box) and prod holds 100 apps. The
phase-5 trial found that 100 parallel reads on 100 apps got ~9 × `503 "app is shutting down"`.

**The cause was not the one first written down** ("`canEvict` ignores statements in flight" — the
pool did check `worker.busy`). `pool.get()` inserted the new worker and THEN looked for someone
to evict: with every other worker busy, the only idle one in the map was the newcomer, whose
caller had not reached `exec` yet. The pool closed the worker it was about to return.

Now `WorkerPool.run(appKey, path, fn)` / `AppManager.withWorker` is the only way to a worker: a
LEASE for the length of `fn`. A leased worker is never evicted; when nobody is evictable the
newcomer WAITS for a lease to end (the live-process cap holds — the alternative, growing past
it, is up to `MAX_INFLIGHT_TOTAL` = 64 node processes on that box). Past `WORKER_WAIT_MS`
(10 s) it is refused `503 UNAVAILABLE` — true ("nothing ran"), replayed by the connector.

Two orderings carry the transactions, each verified to fail first
(`service/test/integration/server/worker-lease.test.ts`):

1. **`/tx/begin` records the tx INSIDE the lease.** The lease's end wakes the waiting apps in the
   same tick; with the registry still unaware of the tx they evicted the worker that had just run
   BEGIN — the next statement then ran OUTSIDE any transaction (auto-committed) and the COMMIT
   answered `no transaction is active`. Silent-loss shaped.
2. **`/tx/commit|rollback` forgets the tx INSIDE the lease**, or the woken apps still find the
   worker unevictable and sleep their whole wait.

`batch-execute` holds ONE lease for all its parameter sets (the worker is idle between two).

**Frequency in prod, measured before fixing** (gateway access log, 7 days to 2026-09-21, ~65 000
requests): **0** such 503 on `POST /query`. It takes > 8 apps inside the same few milliseconds;
the fleet's traffic has not done that yet. The 2 clients without a retry (frontend authorizer,
OTP/passkey Lambda) are why it was fixed anyway.

## One database joins or leaves — the daemon keeps running (2026-09-20, `t_dbmove_p1_ls_socket`)

Every section below that says "bounce" describes what a config change USED to cost: the config
was rewritten and the single litestream process restarted, suspending replication ~1 s for
**every** database on the VM — at each app creation, promotion, eviction and removal.

Litestream 0.5.17 (the pinned binary) has a **control socket**. `buildConfig` now enables it
(`socket: {enabled, path}`), and `Litestream.apply(apps)` — what the four callers use instead of
`bounce` — diffs the wanted set against what the daemon was last told and touches ONLY what
changed: `register -replica <url>` for a database that joins, `stop` then `unregister` for one
that leaves (`service/src/litestream/control.ts`). `stop` "always waits for shutdown and final
sync", so a removal is observed, not assumed. All three are idempotent
(`already_registered` / `already_unregistered`, exit 0).

What stays exactly as it was, on purpose:

- **The config file is still written, first.** A cold start and the respawn-after-crash read it,
  and it is what makes the fallback safe: whatever the socket did or did not do, a bounce
  converges on the file.
- **The bounce is the fallback**, not dead code: no socket configured, a socket command that
  fails or times out (10 s — `stop` waits on S3), a daemon that never opened its socket (3 s),
  or more than 32 changes at once (one ~1 s restart beats that many process spawns under the
  config lock). Journal: `socket-applied {added, removed}` vs `socket-fallback {message}` —
  **a fleet that logs `socket-fallback` regularly has silently gone back to the old cost.**
- **`SyncState.withConfig`** still serializes decide + mutate + apply. The socket removes the
  pause, not the race.
- **Zero databases = no daemon.** With an empty list and a socket, 0.5.17 stays alive but logs
  `level=ERROR msg="no databases specified"`, and any ERROR line flips `childHealthy` (hence
  the heartbeat). So the first database starts the process and the last one stops it — nobody
  else is there to disturb.

Two things found by trying it, each pinned by a test verified to fail first:

1. **The file must go AFTER litestream lets go.** `removeApp` and `doSync` used to delete the
   local file and *then* reconfigure. `stop` closes the database and fails on a deleted one
   (`ensure wal exists: disk I/O error`) — every removal would have fallen back to the bounce,
   quietly. Order is now close executor → `apply` → delete, with the delete in a `finally`
   (`service/test/unit/remove-order.test.ts`).
2. **A unix socket path is capped (~104 bytes).** Past it the daemon dies on
   `bind: invalid argument`. The path defaults to `litestream.sock` beside the config file
   (`/etc/dilaya/`, already owned by the service user — so no infra change), and a path over
   100 chars, or `LITESTREAM_SOCKET_PATH=off`, means "no socket", never a crash.

⚠ A database added by `register` takes litestream's DEFAULT `sync-interval` (1 s) until the next
cold start reads the file — `register` has no such option. Identical to the shipped
`litestreamSyncIntervalMs=1000`; it would only matter if that parameter were changed. The
housekeeping cadences (levels, L0 retention, snapshots) are store-wide and apply either way.

**Tried for real inside the service** (trial stack `dilayadev-lssock-trial`, linux/arm64 under
systemd, S3, destroyed the same hour): 100 apps seeded 6 at a time → **99 `socket-applied`, 0
`socket-fallback`, ONE `replicate-started`, 0 `replicate-exited`** — where the bounce would have
restarted replication 99 times. All 100 prefixes reached S3. A registry row deleted →
`socket-applied {removed: 1}`, the database gone from `litestream list`, the file deleted after.
`systemctl restart` → the daemon comes back on the config file with its socket, 99 listed, no
`bind` error on the stale socket file.

The daemon-to-daemon protocol had been proven on S3 at 100 databases beforehand (`t_dbmove_p0_trial`,
`scripts/acceptance/db-move-trial.mjs`): 0 lost writes, bystanders undisturbed. The pid is the
witness in `service/test/integration/litestream-socket.test.ts`: it must not change when a
database joins or leaves, and must change when the socket is unusable.

## One restore per app at a time (2026-09-19, `t_hotadd_restore_race`)

Seeding the scale trial — 100 apps created 6 at a time — 6 answered **503** on their first
statement: `app could not be prepared: litestream restore failed … cannot restore, output path
already exists and is not empty`. Two paths prepare a brand-new app: `ensureServed` (the
request) and the registry reconcile `doSync`. The first had a per-app mutex; the second never
looked at it. Both saw "no local file", both spawned `litestream restore`, and the slower one
started after the faster had created the fresh db. Invariant 2 held (nothing is restored OVER a
file), so no data was at risk — the cost was a 503 on a new app's first request, or a discarded
reconcile pass. Without the error there was a quieter wrong answer too: the loser could report
`restored` for a file the winner had just created `fresh`, putting a never-written app into
the litestream config.

The mutex now lives in `service/src/litestream/restore.ts` (`Restorer`, keyed by db path),
**below every caller**, so a third path cannot forget it; the second caller gets the first
one's outcome. `service/test/unit/restore-race.test.ts` stages the losing side with a stand-in
binary and was verified to fail first with the verbatim error. The handover catch-up goes through the
same call (it deletes the stale copy, then `restoreIfMissing`) — unaffected: it runs behind the
gate, before anything serves, one task per distinct app.

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
Evicting an app that HAS data was a separate, genuinely risky design (a write
arriving on an unreplicated app would be acknowledged and lost); it is now built
on top of these same two sets — see "Evicting an IDLE app" below.

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

## Evicting an IDLE app from replication (2026-08-24, `service/src/eviction.ts`)

The section above ends with "evicting an app that HAS data is a separate,
genuinely risky design — still unbuilt on purpose". This is that design, built.
What made it tractable is that **the hard part was already there**: `served` vs
`replicated` and the `ensureServed` promotion gate shipped with the
never-written case, so eviction re-uses them rather than inventing anything.

**Eviction means exactly one thing: the app leaves the litestream config.** It
stays served, its file stays on disk, reads keep working with no wake-up, and
the next statement puts it back through the same gate that every data route
already awaits. Nothing is restored, closed or deleted.

**Why it is safe to stop watching a database that HAS data.** The fear is
stranding writes litestream had not yet shipped to S3 — and the THRESHOLD is
what rules it out, not any new flushing machinery: replication runs on a ~1 s
sync interval, and an app is only evictable after DAYS without a change. The
eviction threshold is the flush guarantee. That is also why
`EVICTION_IDLE_DAYS` defaults to **0 (off)** and is never inferred: an operator
sets the number, or nothing is evicted.

**Idleness comes from the write counter, and ignorance is not idleness —
until the ignorance is older than the claim.** `idleMs === null` (an app the
counter has never seen change) is not evictable on that fact alone: the
counter's history begins when it shipped, so the feature ships INERT and
evicting on `null` would have dropped the whole fleet on the first sweep, every
app being unknown.

But that rule alone has an end that undoes the feature, found on the evening the
threshold went live (2026-08-24: the counter had seen **2 of 61** apps write, so
the sweep could free nothing — and for the other 59 it never would). An app that
never writes AT ALL is precisely the one that costs the VM the most, since the
cost is a timer set and a thread rather than a byte. So the observation itself is
**dated**: `WriteStats.ensureObserving()` stamps `sk = "_since"` in the
`_writestats` partition with `if_not_exists`, once ever, and every later boot
reads it back. While the counter has watched for LESS than the threshold, `null`
still protects the app; once it has watched for LONGER, `null` means nothing
wrote during a window we ourselves call idle. `observedForMs() === null` (no
table, no permission, a failed call) forbids eviction — ignorance is the safe
direction. `if_not_exists` is what makes it correct to call on every boot: a roll
cannot move the date forward, and two instances booting together cannot produce
two starts. Global, not per-app, and necessarily so — only apps that WROTE have a
row to date.

**And idle had to stop meaning "unwritten" and start meaning "unused".**
Widening the population exposed a cost the write-only signal had kept rare:
`ensureServed` promotes on ANY access (it runs before the statement, so it
cannot know a read from a write), and every promotion is a fleet-wide bounce. An
app read often but never written — exactly what the maturity rule admits first —
would be evicted, promoted by the next read, evicted by the next sweep: hourly,
per app, forever. So an app this instance SERVED inside the threshold window is
skipped (`recently-served`), reads included. That view is `AppSync.lastTouch`,
which is why `evictIdle` fills `msSinceServed` in itself rather than taking it
from the caller (`InjectedEvictionProbe`). Per-INSTANCE on purpose: unknown
("not served since boot") stays evictable, because the alternative restarts the
clock on every deploy and a fleet that rolls weekly would never evict anything.
The accepted cost is one bounded wave of promotions after a roll instead of an
unbounded hourly flap.

### Two races found while building it, both silent-loss shaped

Neither is visible from either side alone, and each is pinned by a test that was
verified to FAIL without its fix (and only without its own fix):

1. **A config write that disagrees with the set.** `bounce` rewrites the config
   from a SNAPSHOT of `replicated`. Two callers overlapping — a request promoting
   an app while the sweep or the registry poll bounces — let the later write land
   a config computed before the earlier change, leaving an app inside
   `replicated` but absent from the file litestream reads: believed watched, in
   fact unwatched. `AppSync.withConfig` now serializes **decide + mutate + bounce**
   for every caller (promotion, eviction, removal, sync), so whoever writes last
   computed it from the set as it stood under the lock. The eviction plan is
   therefore computed INSIDE the lock — a plan made outside it can go stale in
   the microseconds before it is applied.
2. **The gap between `ensureServed` and the limiter.** The fast path returns
   immediately when an app is already replicated, and `server.ts authorize()`
   acquires the limiter slot only AFTERWARDS. In between, a statement is
   authorised to write while `inFlight` is 0 and no tx is open — invisible to
   every guard. A sweep landing there evicts a database that is about to be
   written. Covered by `EVICT_TOUCH_GRACE_MS` (5 min): `ensureServed` stamps
   `lastTouch` **before** its early return, and a recently-touched app is not a
   candidate. Free, because the threshold it defers to is measured in days.

Beyond those: an app with an **open transaction** is never evicted (a tx's
statements never re-enter `ensureServed` — `use()` only touches the tx
registry), nor is one **mid-promotion** (`pending` holds a request waiting to
write). Every rule errs toward keeping an app replicated: over-replicating costs
a timer and a thread, under-replicating costs a customer their data.

**One bounce per sweep, and none when nothing is evictable.** A bounce suspends
replication ~1 s for every other database on the VM (one litestream process), so
a sweep that finds nothing must not touch the config — otherwise the whole fleet
pays hourly for an empty result.

⚠ Inherited from the promotion gate and worth restating: an app that is only ever
READ is promoted back. Eviction therefore frees apps with **no traffic at all**,
not merely no writes. Classifying SQL to promote on writes only would make a
misclassification a data-loss bug; this stays the conservative side — and since
2026-08-25 the `recently-served` skip makes the planner agree with it, rather
than repeatedly evicting apps the promotion gate will hand straight back.

## Capacity telemetry (2026-08-24, `service/src/capacity.ts`)

The heartbeat answers "is it alive". These answer the question that arrives
BEFORE death — **"how many more apps fit"** — and nothing could answer it until
now: the only way to read litestream's memory was an SSM session and `ps` by
hand, which is to say it was never read.

Metrics in `Dilaya/SqliteData`, published on the heartbeat's own timer and in the
same `PutMetricData` call: `LitestreamRssBytes`, `MemoryAvailableBytes`,
`ServedApps`, `ReplicatedApps`, and — since 2026-08-25 — `DiskAvailableBytes` +
`DiskUsedPercent`. Raw, never pre-divided — RSS-per-app is the interesting
quantity, but a ratio computed on the box is a number nobody can re-slice;
CloudWatch metric math divides at read time.

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

### The disk — the third resource, and the only one nothing gives back (2026-08-25)

Memory got its instrument on 2026-08-24, the thread ceiling was measured the same
day, and eviction shipped to defend both. The filesystem had **nothing**: no
metric read free space, and `quota.ts` measures size per org but never what is
left on the volume.

**Eviction cannot help here, by construction.** `eviction.ts` says it in its own
header — an evicted app leaves the litestream config but *stays served, and its
file stays on disk*. It frees a thread and ~0.46 MB of RSS, never a byte of disk.
Databases of deleted customers are not removed either. Disk is therefore the one
curve that only goes up.

**What the end looks like, and why nothing else could see it coming:** a full
volume is `SQLITE_FULL` on the writes of every org at once — while the heartbeat
still beats (the process is alive), memory is still free, threads are fine, the
Lambdas raise nothing as long as nobody writes, and CloudFront serves 200s. Every
existing instrument stays green until the first error.

**Measured on the production volume, 2026-08-25 — and it is not what the database
sizes suggest:**

```
/            8.51 GB total, 4.37 GB used (52%), 4.14 GB free
/var/lib/dilaya/dbs                       2.10 GB
  ├─ app.db files (61 apps)                726 MB
  └─ .app.db-litestream staging dirs      1.37 GB   ← 1.9× the databases
```

The proposal that opened this work assumed the databases were tiny (the largest
*compressed snapshot* is 220 KB) and that the disk was therefore far away. It is
half full, and the larger half of the database directory is litestream's local
staging, not customer data. One app alone holds a 703 MB `app.db`.

`DiskAvailableBytes` is what the alarm watches; `DiskUsedPercent` rides along
because it is the one that stays comparable after the volume is grown — growing
it changes the denominator, which puts a step in the bytes series and none in the
percentage. `readDiskSpace` returns `null` rather than throwing, same contract as
the `/proc` probes; `diskSpaceFrom` is split out as a pure function so the
arithmetic — the half that can be silently wrong — is tested without needing a
filesystem of a given fullness. An impossible statfs yields `null`, never a
fabricated "0 bytes free, 100% used".

Alarm `${stackName}-disk-headroom` fires under `diskHeadroomBytes` (default 1.5
GiB ≈ 3 months at the observed ~0.5 GB/month), `notBreaching` on missing data for
the same reason as its memory twin. The fix it calls for — growing the gp3 volume
— is an online operation; the point of three months of warning is that it happens
deliberately rather than at 3am.

Boot also logs the volume once (`{"type":"disk","event":"volume",…}`): the metric
answers "is it filling up", the line answers "how big is it", and a size does not
belong in a per-minute series.

### What an app actually costs on disk: ~2x its database (2026-08-25, `t_7f06618a3f17`)

Measuring the volume raised a second question — the database directory was 2.10
GB while the `app.db` files came to 726 MB. The other 1.37 GB sat in litestream's
local `.app.db-litestream/ltx/` directories, and the largest app's held **two
files of 680 MB each, next to a 703 MB database**. The first reading of that was
alarming and **wrong**: it looked as though each write cost a full copy, which
would have meant a handful of writes could fill the volume and take every org's
writes down with it.

Measuring a frequently-written app settles it. **Ordinary writes are deltas of a
few hundred bytes to a few KB**, exactly as designed:

```
app 9e9e8840  db 7.5 MB    ltx files: 3.4K 3.4K 4.8K 17K 2.8K 206B
app 0531dadf  db 356 KB    ltx files: 1.4K 206B 1.4K 206B
```

The full-size file is written **once per app per boot**, right after the restore —
a snapshot of the whole database, not a delta. Its size tracks the database, not
the traffic: 97% of the database for the big app, 35-71% for small ones (SQLite
page granularity makes the ratio noisier when the file is tiny).

**And retention does reclaim it.** Watched across the 3 h `litestreamL0Retention`
horizon on the 2026-08-25 boot: of the two 680 MB files written at 08:06, the
older was gone by 11:39 and the newest kept. Fleet-wide the staging directories
then came to **0.94x** the database bytes (684 MB against 726 MB) — i.e. about
one snapshot per app.

So the sizing law, which nothing stated before:

    disk per app  ≈  2 x its database        (steady state: db + one snapshot)
                  ≈  3 x its database        (transiently, for `litestreamL0Retention`
                                              after a roll — the new snapshot while
                                              the previous one lives out its window)

**The consequence worth remembering is about ROLLS, not writes.** Every instance
replacement writes fresh full-size snapshots for every app at once.

**Measured live on the 0.1.171 roll (2026-08-25 11:47), by the instrument this
very work added** — the first time this could be watched at all. The boot line
reported 34.5% used (5.57 GB free); twenty minutes later the metric read 50.6%
(4.20 GB). **A roll costs ~1.37 GB against 726 MB of databases, i.e. ~1.9x the
fleet's database bytes, not ~1x** — because the snapshot is written more than
once per app during the post-restore settle (the big app produced two 680 MB
files on each of the two boots observed). That is the number to size the volume
with, and it is consistent with the ~3x peak above (703 MB database + 1.36 GB of
snapshots = 2.9x for that app). It scales with total database bytes
and not with app count, so the number to watch is the sum of `app.db`, and
`diskHeadroomBytes` should stay **above** it — the alarm's real meaning is "you
are within one roll of trouble".

⚠ The per-org quota (`maxDbMb`, invariant 10) measures the `app.db` file alone.
An org's true footprint on this volume is about twice what the quota counts.
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

- `GET /stats?org_id&app_id → {dbSizeBytes, mainBytes}` — capability-gated usage endpoint; the
  connector's `get-usage-report` calls it. `dbSizeBytes` counts db + WAL (reporting); `mainBytes`
  (0.1.49) is the db file alone — what the quota counts (invariant 10), so the connector's gate can
  judge the same number as this VM.
- **Org db quota** — reads `maxDbMb` off the registry's `sk='org'` row (written by the connector
  when it refreshes org-info from dilaya.eu; no new IAM, same table as the app rows) and refuses
  `/query` + `/batch-execute` writes past it with `DB_QUOTA_EXCEEDED` (429). This closes the last
  hole in the caps: a per-app Lambda writes here DIRECTLY with its own capability token, so the
  connector's own enforcement never sees those statements.
- `POST /admin/delete-app {org_id, app_id}` — drop-schema teardown: close executor, drop from
  litestream config, delete the local file, **KEEP the S3 replica**. Capability-gated but skips
  the active-status check (the connector flips the registry row to `deleting` first); the
  connector's `drop-schema` calls it.
