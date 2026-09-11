// The check itself: check-then-act, on a cached measurement whose TTL tightens
// as the org approaches its cap. NOTHING IS EVER DELETED — being over the cap
// refuses the NEXT write and says what to do; every byte stays readable.
import { ServiceError } from "../errors.ts";
import { measureOrgDbBytes } from "./measure.ts";
import { MB, humanBytes, measureTtlMs, overQuota, sqlSkipsQuota } from "./policy.ts";
import type { OrgQuotaReader } from "./readers.ts";

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
