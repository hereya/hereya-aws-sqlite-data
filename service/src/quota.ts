// Database quota — the LAST path a cap could not reach.
//
// dilaya.eu decides `maxDbMb`; the connector caches it on the registry's org
// row and enforces it on the paths IT drives (agent `execute`, bulk-insert).
// But a deployed per-app Lambda talks to this service DIRECTLY with its own
// capability token — the connector is not in that loop, so those writes were
// invisible to the cap. This module closes that hole where the bytes actually
// land: on the VM that owns the files.
//
// It follows the connector's doctrine (dilaya-connector/src/quotas.ts) rather
// than inventing a second one:
//
//   * `null`/absent/unreadable = NO cap. Quotas FAIL OPEN — the opposite of the
//     registry lookup right next to it, and deliberately so: that one answers
//     "may this caller touch this app" (a security question, fail closed), this
//     one answers "has this customer bought enough space" (a commercial one).
//     Refusing an org's own writes because DynamoDB blinked would be a far
//     worse failure than not enforcing a cap for one more request.
//   * NOTHING IS EVER DELETED. Over the cap refuses the NEXT write and says
//     what to do; every byte stays readable and downloadable.
//   * Reads and space-FREEING statements always pass (DELETE / DROP / VACUUM).
//     The refusal tells the person to free space, so refusing the statements
//     that free it would lock them in a room whose key we just handed them.
//   * Measure, don't accumulate. Usage is the real size of the org's files on
//     this disk — no ledger to drift out of sync, and a customer who frees
//     space is unblocked by the next refresh. Cached with a short TTL that
//     tightens as the org approaches its cap (see measureTtlMs).
//   * Check-then-act. The overshoot is bounded by one in-flight statement plus
//     whatever lands inside the cache window — caps here are commercial, not
//     safety-critical.
//   * An UNCAPPED org pays exactly one cached DynamoDB read and never a
//     filesystem walk.
//
// Where this differs from the connector, on purpose: for a multi-statement
// script the connector looks at the head only, while here EVERY statement must
// be exempt for the script to pass. Being stricter costs nothing (the check
// only runs for an org already over its cap) and closes the obvious
// "DELETE …; INSERT …" bypass.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { ServiceError } from "./errors.ts";
import { stripSqlLiterals } from "./validate.ts";

export const MB = 1024 * 1024;

/** Source of an org's `maxDbMb` (megabytes), `null` when uncapped. */
export interface OrgQuotaReader {
  /** Never throws: an unreadable quota is an ABSENT quota (fail open). */
  maxDbMb(orgId: string): Promise<number | null>;
}

/** Local/dev + tests: a fixed map of caps, no AWS. */
export class StaticOrgQuotaReader implements OrgQuotaReader {
  private readonly caps: Map<string, number | null>;

  constructor(caps: Record<string, number | null> = {}) {
    this.caps = new Map(Object.entries(caps));
  }

  async maxDbMb(orgId: string): Promise<number | null> {
    return this.caps.get(orgId) ?? null;
  }
}

/**
 * Reads `maxDbMb` off the registry's org row (PK org_id, SK 'org') — the same
 * table this service already reads app rows from, so no new IAM.
 *
 * The connector writes that attribute when it refreshes org-info from
 * dilaya.eu; a row cached before quotas existed simply has no attribute, which
 * reads as "uncapped" and is exactly right.
 */
export class DdbOrgQuotaReader implements OrgQuotaReader {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { cap: number | null; at: number }>();

  constructor(opts: {
    tableName: string;
    region: string;
    cacheMs: number;
    client?: DynamoDBClient;
    now?: () => number;
  }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required to read org quotas");
    this.tableName = opts.tableName;
    this.cacheMs = opts.cacheMs;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
    this.now = opts.now ?? Date.now;
  }

  async maxDbMb(orgId: string): Promise<number | null> {
    const cached = this.cache.get(orgId);
    if (cached && this.now() - cached.at < this.cacheMs) return cached.cap;
    let cap: number | null;
    try {
      const res = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: { org_id: { S: orgId }, sk: { S: "org" } },
          ProjectionExpression: "maxDbMb",
        }),
      );
      cap = positiveOrNull(res.Item?.maxDbMb?.N);
    } catch (err) {
      // Fail open, and do NOT cache the failure: the next request retries.
      console.warn(JSON.stringify({ type: "quota", event: "cap_unreadable", orgId, message: (err as Error).message }));
      return null;
    }
    this.cache.set(orgId, { cap, at: this.now() });
    return cap;
  }
}

function positiveOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Human-readable size for a refusal message (the reader is not an engineer). */
export function humanBytes(bytes: number): string {
  const GB = 1024 * MB;
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes / GB >= 10 ? 0 : 1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes / MB >= 10 ? 0 : 1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/** At OR past the cap refuses: a 205 MB cap means 205 MB is the ceiling. */
export function overQuota(used: number, cap: number): boolean {
  return used >= cap;
}

/**
 * How long a measurement stays trusted — the window an org can overshoot by,
 * since the check reads a cached number.
 *
 * MUCH tighter than the connector's equivalent (30 min / 5 min / 1 min), and
 * deliberately: there, measuring means walking an org's S3 prefix, so a long
 * TTL buys real savings. Here it is a readdir plus two stat calls per app —
 * microseconds on a local disk. Paying that every two minutes to shrink the
 * overshoot from "half an hour of bulk inserts" to "two minutes of them" is an
 * obviously good trade, and the one thing that would make the cap useless is
 * letting an import blow past it while the number sits frozen.
 */
export function measureTtlMs(used: number, cap: number): number {
  if (cap <= 0) return 120_000;
  const ratio = used / cap;
  if (ratio >= 0.9) return 5_000;
  if (ratio >= 0.5) return 30_000;
  return 120_000;
}

// Statement heads the cap must not stand in the way of: reads, and the
// statements that FREE space. Mirrors the connector's list verbatim (VACUUM is
// what actually shrinks a SQLite file after a DELETE, so it has to pass too).
const QUOTA_EXEMPT_HEAD = /^\s*\(*\s*(SELECT|WITH|EXPLAIN|PRAGMA|DELETE|DROP|VACUUM|ANALYZE|REINDEX)\b/i;

/**
 * Does this SQL bypass the cap? Every statement must qualify — a script mixing
 * a DELETE with an INSERT is a write, not a cleanup.
 */
export function sqlSkipsQuota(sql: string): boolean {
  const statements = stripSqlLiterals(sql)
    .split(";")
    .filter((s) => /\S/.test(s));
  if (statements.length === 0) return true; // nothing to run
  return statements.every((s) => QUOTA_EXEMPT_HEAD.test(s));
}

/**
 * Total bytes of every database this VM holds for the org.
 *
 * MAIN FILE ONLY — deliberately NOT the same accounting as GET /stats, which
 * adds the WAL because it reports "what is this app using right now". A cap
 * must not count the WAL, for one decisive reason: in WAL mode `VACUUM`
 * rewrites the entire database THROUGH the WAL, so the single statement that
 * frees space would briefly double the measured usage — the way out would
 * register as growth and keep the customer locked in. The WAL is a transient
 * buffer anyway (SQLite auto-checkpoints it, and shutdown folds it in), so the
 * main file is both the stabler and the more honest number.
 *
 * The instance restores EVERY active app at boot (see AppSync.bootRestoreAll),
 * so this sum is the org's whole footprint. Were the service ever sharded
 * across instances it would UNDER-count, which is the safe direction: it can
 * only fail to refuse, never refuse someone who is under their cap.
 */
export function measureOrgDbBytes(dbDir: string, orgId: string): number {
  let entries;
  try {
    entries = readdirSync(join(dbDir, orgId), { withFileTypes: true });
  } catch {
    return 0; // org has nothing on disk yet
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      total += statSync(join(dbDir, orgId, entry.name, "app.db")).size;
    } catch {
      // absent (app never written to) — counts as 0
    }
  }
  return total;
}

/** Refuses writes for an org whose databases are at or over `maxDbMb`. */
export class DbQuotaGuard {
  private readonly dbDir: string;
  private readonly reader: OrgQuotaReader;
  private readonly now: () => number;
  private readonly measure: (dbDir: string, orgId: string) => number;
  private readonly usage = new Map<string, { bytes: number; at: number; ttl: number }>();

  constructor(opts: {
    dbDir: string;
    reader: OrgQuotaReader;
    now?: () => number;
    /** Seam for tests; production always measures the real files. */
    measure?: (dbDir: string, orgId: string) => number;
  }) {
    this.dbDir = opts.dbDir;
    this.reader = opts.reader;
    this.now = opts.now ?? Date.now;
    this.measure = opts.measure ?? measureOrgDbBytes;
  }

  /**
   * Throws DB_QUOTA_EXCEEDED when this statement would grow an org that has
   * already reached its cap. Returns immediately (no disk, no network beyond a
   * cached cap read) for exempt SQL and for uncapped orgs.
   */
  async assertWriteAllowed(orgId: string, sql: string): Promise<void> {
    if (sqlSkipsQuota(sql)) return;
    const capMb = await this.reader.maxDbMb(orgId);
    if (capMb === null) return;
    const cap = capMb * MB;
    const used = this.bytesFor(orgId, cap);
    if (!overQuota(used, cap)) return;
    console.log(
      JSON.stringify({ type: "quota", ts: new Date().toISOString(), orgId, kind: "db", used, cap, refused: true }),
    );
    throw new ServiceError(
      "DB_QUOTA_EXCEEDED",
      `Your organization's databases use ${humanBytes(used)} of the ${humanBytes(cap)} included in your plan, ` +
        `so new data cannot be written for now. Nothing has been deleted and everything stays readable — ` +
        `free space by removing data you no longer need, or contact Dilaya to raise the limit.`,
    );
  }

  /** Cached measurement; the TTL tightens as the org nears its cap. */
  private bytesFor(orgId: string, cap: number): number {
    const now = this.now();
    const cached = this.usage.get(orgId);
    if (cached && now - cached.at < cached.ttl) return cached.bytes;
    const bytes = this.measure(this.dbDir, orgId);
    this.usage.set(orgId, { bytes, at: now, ttl: measureTtlMs(bytes, cap) });
    return bytes;
  }
}
