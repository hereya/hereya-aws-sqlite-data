// The durable half: seeding at boot, dating the observation, and the background
// flush. Every call here is failure-tolerant by design — a statistic must never
// be able to break a boot or a customer's write.
import {
  UpdateItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

import { WriteStatsCounter } from "./counter.ts";
import { OBSERVING_SINCE_KEY, WRITE_STATS_PARTITION } from "./keys.ts";
import { markOf, pendingSince } from "./stat.ts";

export class WriteStats extends WriteStatsCounter {
  private timer: NodeJS.Timeout | null = null;

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
        const rawWrite = Number(item.lastWriteMs?.N ?? "0");
        const rawTouch = Number(item.lastTouchMs?.N ?? "0");
        const lastWriteMs = Number.isFinite(rawWrite) && rawWrite > 0 ? rawWrite : 0;
        const lastTouchMs = Number.isFinite(rawTouch) && rawTouch > 0 ? rawTouch : 0;
        // A row is worth loading if EITHER half is usable. Requiring a write
        // (which is what this did before touches existed) would drop exactly
        // the read-only apps the touch mark is for.
        if (!key || (lastWriteMs === 0 && lastTouchMs === 0)) continue;
        this.stats.set(key, { lastWriteMs, writes: Number(item.writes?.N ?? "0"), lastTouchMs });
        this.flushed.set(key, { lastWriteMs, lastTouchMs });
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
            UpdateExpression: "SET lastWriteMs = :t, writes = :w, lastTouchMs = :u",
            ExpressionAttributeValues: {
              ":t": { N: String(stat.lastWriteMs) },
              ":w": { N: String(stat.writes) },
              ":u": { N: String(stat.lastTouchMs) },
            },
          })
        );
        this.flushed.set(key, markOf(stat));
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
