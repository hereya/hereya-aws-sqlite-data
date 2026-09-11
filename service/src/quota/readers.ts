// Where an org's cap comes from. `null`/absent/unreadable = NO cap: quotas FAIL
// OPEN, unlike the registry lookup right next to them (see the module header in
// ../quota.ts for why the two answer opposite kinds of question).
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

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
