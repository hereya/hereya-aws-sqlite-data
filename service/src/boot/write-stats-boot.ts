import type { WriteStats } from "../write-stats.ts";

/**
 * Seed the per-app write counter from DynamoDB and date the observation.
 * Never fails a boot: a statistic is not worth refusing to serve over.
 */
export async function seedWriteStats(writeStats: WriteStats): Promise<void> {
  try {
    const loaded = await writeStats.load();
    if (loaded > 0) {
      // `withTouch` is a field only this build emits, and it is the positive
      // trace that the durable access mark actually crossed the replacement:
      // a count above zero means this instance started already knowing which
      // apps the previous one was serving. See t_3bdea3eeebb6.
      const withTouch = [...writeStats.snapshot().values()].filter((s) => s.lastTouchMs > 0).length;
      console.log(JSON.stringify({ type: "write-stats", event: "loaded", apps: loaded, withTouch }));
    }
    // Date the observation itself. Written once, ever, then read back on every
    // later boot — it is what lets "we have never seen this app write" mature
    // from ignorance into evidence. See src/eviction.ts.
    const since = await writeStats.ensureObserving();
    console.log(
      JSON.stringify({
        type: "write-stats",
        event: "observing",
        since: since === null ? null : new Date(since).toISOString(),
        forDays: since === null ? null : Math.round((Date.now() - since) / 86_400_000),
      }),
    );
  } catch (err) {
    // Never fail a boot over a statistic.
    console.error(JSON.stringify({ type: "write-stats", event: "load-failed", message: (err as Error).message }));
  }
}
