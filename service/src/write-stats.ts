// When did each app last CHANGE its database?
//
// This is the number every remaining optimisation waits on: the eviction
// threshold (how long without a write before an app leaves the replication
// set), which apps belong on a slow-cadence litestream process, and the
// anti-abuse creation limit all need the DISTRIBUTION of write-idleness per
// app — not its average.
//
// It could not be obtained from the replica bucket: every VM roll makes
// litestream snapshot each database, which stamps a fresh L0 file and floors
// the signal at "last boot". On 2026-08-24 four rolls in one day erased it four
// times; 58 of 61 apps showed a last write inside the same two-minute window,
// twenty-five minutes after a deploy. Waiting for a quiet week is betting
// against our own release rhythm.
//
// THE VM IS THE ONLY PLACE THIS CAN BE COUNTED. A per-app frontend Lambda
// writes to the Data API directly with its own capability token, so the
// connector never sees those statements — but they all land here.
//
// Design constraints, in order of importance:
//
//  1. It sits on the write path, so it must NEVER be able to fail a customer's
//     write. The hot path is a single Map.set — no I/O, no await, nothing that
//     can throw. Persistence happens on a background timer, and a failed flush
//     costs resolution, never data.
//  2. It must survive instance replacement, which is exactly what the S3
//     timestamps did not.
//  3. It must not widen what the data plane can reach. Rows live in a FIXED
//     `_writestats` partition of the registry table (the same trick the
//     connector uses for `_hosts` and `_catalog` — org ids are UUIDs, so the
//     literal can never collide), and the instance role's write grant is
//     conditioned on that partition key alone. The VM still cannot touch a
//     single org or app row.
//
// "A write" means the statement CHANGED the database (`info.changes > 0`).
// That is deliberately the same definition litestream reacts to: a statement
// touching zero rows produces no LTX file and costs no replication, so counting
// it would measure something other than what we are trying to price.
import {
  DynamoDBClient,
  UpdateItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/** The fixed partition. Org ids are UUIDs, so this literal cannot collide. */
export const WRITE_STATS_PARTITION = "_writestats";

/**
 * The sort key holding WHEN THIS COUNTER FIRST STARTED WATCHING.
 *
 * Every app row's sort key is `<orgId>/<appId>` and therefore contains a
 * slash; this one does not, so it can never be mistaken for an app — the same
 * argument that makes the partition literal safe, one level down.
 *
 * It exists because "never seen writing" is ambiguous, and the ambiguity has a
 * clock. On the day the counter shipped it means "we know nothing". After the
 * counter has watched for longer than the eviction threshold it means
 * something quite different: nothing wrote for that whole period. Without a
 * durable start date the two are indistinguishable forever, and an app that
 * never writes — the very one that costs the VM the most — can never be
 * evicted. See `planEviction`, which is the only reader.
 *
 * Durability is the whole point, and it is why this lives in DynamoDB next to
 * the counters rather than in memory: an instance replacement must not restart
 * the observation. That is exactly the trap that forced the counters
 * themselves out of the replica bucket (four VM rolls on 2026-08-24).
 */
export const OBSERVING_SINCE_KEY = "_since";

export interface WriteStat {
  /** Epoch ms of the last statement that changed this database. */
  lastWriteMs: number;
  /** Statements that changed it since this row was created. */
  writes: number;
}

/** `<orgId>/<appId>` — the sort key, and the in-memory map key. */
export function statKey(orgId: string, appId: string): string {
  return `${orgId}/${appId}`;
}

/**
 * Which entries changed since the last flush.
 *
 * Pure, so the flush policy is testable without DynamoDB. Only apps that were
 * actually written are flushed, so the write cost is proportional to real
 * activity rather than to the number of apps we host — which is the whole point
 * of the exercise.
 */
export function pendingSince(
  stats: ReadonlyMap<string, WriteStat>,
  flushedAt: ReadonlyMap<string, number>
): string[] {
  const out: string[] = [];
  for (const [key, stat] of stats) {
    if (flushedAt.get(key) !== stat.lastWriteMs) out.push(key);
  }
  return out;
}

export class WriteStats {
  private readonly stats = new Map<string, WriteStat>();
  private readonly flushed = new Map<string, number>();
  private readonly client: DynamoDBClient | null;
  private readonly tableName: string;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  /** Epoch ms this counter began observing; null while unknown. */
  private observingSince: number | null = null;

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
    const prev = this.stats.get(key);
    if (prev) {
      prev.lastWriteMs = this.now();
      prev.writes += 1;
    } else {
      this.stats.set(key, { lastWriteMs: this.now(), writes: 1 });
    }
  }

  /** Snapshot for readers (admin surface, tests). */
  snapshot(): Map<string, WriteStat> {
    return new Map([...this.stats].map(([k, v]) => [k, { ...v }]));
  }

  /** Milliseconds since this app last changed; null when never seen. */
  idleMsFor(orgId: string, appId: string): number | null {
    const stat = this.stats.get(statKey(orgId, appId));
    return stat ? this.now() - stat.lastWriteMs : null;
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

  /**
   * Stamp the observation start if it has never been stamped, and adopt
   * whatever value wins.
   *
   * `if_not_exists` makes this a single atomic call that is correct to run on
   * EVERY boot: the first instance ever to run it sets the date, every later
   * one reads back the date already there. There is no race to lose and no
   * conditional failure to handle — two instances booting together cannot
   * produce two different starts, and a roll cannot move it forward.
   *
   * Failure is silent on purpose. A counter that cannot date itself returns
   * null, and null forbids eviction — the safe direction.
   */
  async ensureObserving(): Promise<number | null> {
    if (!this.client || !this.tableName) return this.observingSince;
    try {
      const res = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { org_id: { S: WRITE_STATS_PARTITION }, sk: { S: OBSERVING_SINCE_KEY } },
          UpdateExpression: "SET startedMs = if_not_exists(startedMs, :t)",
          ExpressionAttributeValues: { ":t": { N: String(this.now()) } },
          ReturnValues: "ALL_NEW",
        })
      );
      const stamped = Number(res.Attributes?.startedMs?.N ?? "");
      if (Number.isFinite(stamped) && stamped > 0) this.observingSince = stamped;
    } catch (err) {
      console.error(
        JSON.stringify({ type: "write-stats", event: "observing-since-failed", message: (err as Error).message })
      );
    }
    return this.observingSince;
  }

  /** Seed from DynamoDB at boot, so an instance replacement keeps the history. */
  async load(): Promise<number> {
    if (!this.client || !this.tableName) return 0;
    let loaded = 0;
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "org_id = :p",
          ExpressionAttributeValues: { ":p": { S: WRITE_STATS_PARTITION } },
          ExclusiveStartKey: startKey,
        })
      );
      for (const item of res.Items ?? []) {
        const key = item.sk?.S;
        // The observation date shares the partition but is not an app.
        if (key === OBSERVING_SINCE_KEY) {
          const started = Number(item.startedMs?.N ?? "");
          if (Number.isFinite(started) && started > 0) this.observingSince = started;
          continue;
        }
        const lastWriteMs = Number(item.lastWriteMs?.N ?? "0");
        if (!key || !Number.isFinite(lastWriteMs) || lastWriteMs <= 0) continue;
        this.stats.set(key, { lastWriteMs, writes: Number(item.writes?.N ?? "0") });
        this.flushed.set(key, lastWriteMs);
        loaded += 1;
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return loaded;
  }

  /**
   * Persist only what moved. Never throws: a flush that fails costs at most one
   * interval of resolution, and the next one carries the same entries again.
   */
  async flush(): Promise<number> {
    if (!this.client || !this.tableName) return 0;
    const keys = pendingSince(this.stats, this.flushed);
    let written = 0;
    for (const key of keys) {
      const stat = this.stats.get(key);
      if (!stat) continue;
      try {
        await this.client.send(
          new UpdateItemCommand({
            TableName: this.tableName,
            Key: { org_id: { S: WRITE_STATS_PARTITION }, sk: { S: key } },
            UpdateExpression: "SET lastWriteMs = :t, writes = :w",
            ExpressionAttributeValues: {
              ":t": { N: String(stat.lastWriteMs) },
              ":w": { N: String(stat.writes) },
            },
          })
        );
        this.flushed.set(key, stat.lastWriteMs);
        written += 1;
      } catch (err) {
        // Loud enough to notice, quiet enough never to matter to a request.
        console.error(
          JSON.stringify({ type: "write-stats", event: "flush-failed", key, message: (err as Error).message })
        );
      }
    }
    if (written > 0) console.log(JSON.stringify({ type: "write-stats", event: "flushed", apps: written }));
    return written;
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
