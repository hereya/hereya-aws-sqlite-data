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
   litestream writers on one generation path.
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
- Noisy-neighbor: victim p95 143→144ms under a 40-bomb flood. A flooding app's QUEUED
  requests can exceed API Gateway's 30s integration timeout → the gateway returns 503
  (retryable) for those; per-app cap returns 429; the SQL deadline returns 408. All three
  are contained to the offending app.
- **Spot reality check**: t4g Spot went unfulfillable across 2 AZs + 2 sizes in eu-west-1
  for >10 min — that's why the default is on-demand (`spotPercentage=0`); Spot is opt-in.

## Connector-track interfaces (implemented)

- `GET /stats?org_id&app_id → {dbSizeBytes}` — capability-gated usage endpoint; the connector's
  `get-usage-report` calls it.
- `POST /admin/delete-app {org_id, app_id}` — drop-schema teardown: close executor, drop from
  litestream config, delete the local file, **KEEP the S3 replica**. Capability-gated but skips
  the active-status check (the connector flips the registry row to `deleting` first); the
  connector's `drop-schema` calls it.
