// The in-memory half of the counter: the two hot paths and the readers built
// on them. Nothing here does I/O — see `store.ts` for the durable half.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { statKey, type FlushedMark, type WriteStat } from "./stat.ts";

export class WriteStatsCounter {
  protected readonly stats = new Map<string, WriteStat>();
  protected readonly flushed = new Map<string, FlushedMark>();
  protected readonly client: DynamoDBClient | null;
  protected readonly tableName: string;
  protected readonly now: () => number;
  /** Epoch ms this counter began observing; null while unknown. */
  protected observingSince: number | null = null;

  constructor(opts: {
    tableName: string;
    region: string;
    client?: DynamoDBClient;
    now?: () => number;
  }) {
    this.tableName = opts.tableName;
    this.now = opts.now ?? (() => Date.now());
    this.client = opts.tableName
      ? (opts.client ?? new DynamoDBClient({ region: opts.region }))
      : (opts.client ?? null);
  }

  /**
   * The hot path. Called after a statement that changed the database.
   *
   * Synchronous and allocation-light on purpose: this runs inside every
   * customer write, and the one thing it must never do is add a failure mode to
   * one.
   */
  record(orgId: string, appId: string, changed: number): void {
    if (changed <= 0) return;
    const key = statKey(orgId, appId);
    const at = this.now();
    const prev = this.stats.get(key);
    if (prev) {
      prev.lastWriteMs = at;
      prev.writes += 1;
      // A write IS an access. `ensureServed` has already stamped it on the way
      // in, so this is belt-and-braces — but it costs one assignment and it
      // removes any need to reason about which of the two ran first.
      prev.lastTouchMs = at;
    } else {
      this.stats.set(key, { lastWriteMs: at, writes: 1, lastTouchMs: at });
    }
  }

  /**
   * The OTHER hot path: someone used this app, for anything, reads included.
   *
   * Same contract as `record` — a single `Map` write, no I/O, nothing that can
   * throw — because it runs inside `ensureServed`, which every statement passes
   * through before any SQL executes. Making this durable per call would mean a
   * DynamoDB write for every read of every customer site; it is persisted by
   * the same background flush as the write counter instead, and 5-minute
   * resolution against a threshold measured in days is not a distinction that
   * can matter.
   *
   * ⚠️ It must NOT invent a write. A touch-only entry keeps `lastWriteMs: 0`,
   * which `idleMsFor` reports as null — otherwise reading an app would make it
   * look freshly written and nothing would ever become evictable.
   */
  recordTouch(key: string, atMs?: number): void {
    const at = atMs ?? this.now();
    const prev = this.stats.get(key);
    if (prev) {
      prev.lastTouchMs = at;
    } else {
      this.stats.set(key, { lastWriteMs: 0, writes: 0, lastTouchMs: at });
    }
  }

  /** Snapshot for readers (admin surface, tests). */
  snapshot(): Map<string, WriteStat> {
    return new Map([...this.stats].map(([k, v]) => [k, { ...v }]));
  }

  /**
   * Milliseconds since this app last CHANGED; null when never seen writing.
   *
   * A touch-only entry (created by a read) carries `lastWriteMs: 0` and must
   * answer null here, exactly as a missing entry does — reading an app is not
   * evidence about writing it.
   */
  idleMsFor(orgId: string, appId: string): number | null {
    const stat = this.stats.get(statKey(orgId, appId));
    if (!stat || stat.lastWriteMs <= 0) return null;
    return this.now() - stat.lastWriteMs;
  }

  /**
   * Milliseconds since this app was last USED (reads included); null when it
   * has never been seen.
   *
   * This is what survives an instance replacement, and the reason the whole
   * change exists: `AppSync` keeps a live in-memory mark that is more precise,
   * and falls back to this one for every app it has not been asked about since
   * boot.
   */
  msSinceTouch(key: string): number | null {
    const stat = this.stats.get(key);
    if (!stat || stat.lastTouchMs <= 0) return null;
    return Math.max(0, this.now() - stat.lastTouchMs);
  }

  /**
   * How long this counter has been watching, in ms; null when it cannot tell.
   *
   * This is deliberately a GLOBAL property, not a per-app one, and it has to
   * be: only apps that actually wrote are ever persisted, so there is no
   * per-app row to date for the apps this number exists to reason about. What
   * it licenses is a single inference — "nothing wrote for the whole window" —
   * which is exactly the one eviction needs.
   *
   * Null is the ignorant answer and it must stay distinguishable from zero:
   * callers treat it as "do not conclude anything", which keeps an app
   * replicated.
   */
  observedForMs(): number | null {
    return this.observingSince === null ? null : Math.max(0, this.now() - this.observingSince);
  }

  /** Epoch ms of the observation start, for logs; null while unknown. */
  get observingSinceMs(): number | null {
    return this.observingSince;
  }
}
