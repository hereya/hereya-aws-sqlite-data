// Where an org's cap comes from. `null`/absent/unreadable = NO cap: quotas FAIL
// OPEN, unlike the registry lookup right next to them (see the module header in
// ../quota.ts for why the two answer opposite kinds of question).
//
// The same org row also carries the migration freeze (../fence.ts): ONE GetItem
// reads both, under two TTLs — the cap's (ORG_QUOTA_CACHE_MS, 30 s) and the
// freeze's, much shorter (ORG_FENCE_CACHE_MS, 2 s), because a freeze must bite
// within seconds. Whichever expires first refreshes the row for both.
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { OrgFenceReader } from "../fence.ts";

/** Source of an org's `maxDbMb` (megabytes), `null` when uncapped. */
export interface OrgQuotaReader {
  /** Never throws: an unreadable quota is an ABSENT quota (fail open). */
  maxDbMb(orgId: string): Promise<number | null>;
}

/** Local/dev + tests: a fixed map of caps (and of frozen orgs), no AWS. */
export class StaticOrgQuotaReader implements OrgQuotaReader, OrgFenceReader {
  private readonly caps: Map<string, number | null>;
  /** Mutable on purpose: a test freezes and unfreezes an org mid-run. */
  readonly frozen: Set<string>;

  constructor(caps: Record<string, number | null> = {}, frozen: Iterable<string> = []) {
    this.caps = new Map(Object.entries(caps));
    this.frozen = new Set(frozen);
  }

  async maxDbMb(orgId: string): Promise<number | null> {
    return this.caps.get(orgId) ?? null;
  }

  async migrationFrozen(orgId: string): Promise<boolean> {
    return this.frozen.has(orgId);
  }
}

interface OrgRowSnapshot {
  cap: number | null;
  frozen: boolean;
  at: number;
}

/**
 * Reads `maxDbMb` and `migrationFreeze` off the registry's org row (PK org_id,
 * SK 'org') — the same table this service already reads app rows from, so no
 * new IAM.
 *
 * The connector writes `maxDbMb` when it refreshes org-info from dilaya.eu; a
 * row cached before quotas existed simply has no attribute, which reads as
 * "uncapped" and is exactly right. `migrationFreeze` is written by the org
 * migration (admin-org-migrate); ANY value present means frozen, as there.
 */
export class DdbOrgQuotaReader implements OrgQuotaReader, OrgFenceReader {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly cacheMs: number;
  private readonly fenceCacheMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, OrgRowSnapshot>();
  /** One GetItem per org in flight: a burst of writes after expiry shares it. */
  private readonly inflight = new Map<string, Promise<OrgRowSnapshot | null>>();

  constructor(opts: {
    tableName: string;
    region: string;
    cacheMs: number;
    /** Freeze TTL; defaults to 2 s. */
    fenceCacheMs?: number;
    client?: DynamoDBClient;
    now?: () => number;
  }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required to read org quotas");
    this.tableName = opts.tableName;
    this.cacheMs = opts.cacheMs;
    this.fenceCacheMs = opts.fenceCacheMs ?? 2_000;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
    this.now = opts.now ?? Date.now;
  }

  async maxDbMb(orgId: string): Promise<number | null> {
    // Fail open, and do NOT reuse a stale cap on failure: the next request retries.
    return (await this.row(orgId, this.cacheMs))?.cap ?? null;
  }

  async migrationFrozen(orgId: string): Promise<boolean> {
    // Fail open but STICKY: on failure, the last answer this VM saw (fence.ts).
    const row = (await this.row(orgId, this.fenceCacheMs)) ?? this.cache.get(orgId);
    return row?.frozen ?? false;
  }

  /** A row no older than `maxAgeMs`, or null when the read failed. */
  private async row(orgId: string, maxAgeMs: number): Promise<OrgRowSnapshot | null> {
    const cached = this.cache.get(orgId);
    if (cached && this.now() - cached.at < maxAgeMs) return cached;
    let pending = this.inflight.get(orgId);
    if (!pending) {
      pending = this.read(orgId).finally(() => this.inflight.delete(orgId));
      this.inflight.set(orgId, pending);
    }
    return pending;
  }

  private async read(orgId: string): Promise<OrgRowSnapshot | null> {
    try {
      const res = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: { org_id: { S: orgId }, sk: { S: "org" } },
          ProjectionExpression: "#cap, #freeze",
          ExpressionAttributeNames: { "#cap": "maxDbMb", "#freeze": "migrationFreeze" },
          // A freeze is acted on within the fence TTL, not after replication lag.
          ConsistentRead: true,
        }),
      );
      const row = {
        cap: positiveOrNull(res.Item?.maxDbMb?.N),
        frozen: res.Item?.migrationFreeze !== undefined,
        at: this.now(),
      };
      this.cache.set(orgId, row);
      return row;
    } catch (err) {
      // Not cached: the next request retries.
      console.warn(JSON.stringify({ type: "quota", event: "cap_unreadable", orgId, message: (err as Error).message }));
      return null;
    }
  }
}

function positiveOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
