// The idle sweep: which replicated apps stop being replicated, and the two
// guards `AppSync` owns that the pure planner in ../eviction.ts cannot see.
import {
  EVICT_TOUCH_GRACE_MS,
  planEviction,
  type EvictionPlan,
  type EvictionProbe,
  type InjectedEvictionProbe,
} from "../eviction.ts";
import { log } from "./log.ts";
import type { SyncState } from "./state.ts";

/**
 * Drop every app that has been quiet for `thresholdMs` from the litestream
 * config — one config change for the whole batch, not one per app.
 *
 * The plan is computed INSIDE the config lock, deliberately. A plan made
 * outside it can go stale in the microseconds before it is applied: a request
 * arriving in that window promotes its app (and writes to it), and applying
 * the older decision afterwards would evict an app that had just been
 * written. Deciding under the lock means the idleness, the open-transaction
 * check and the in-flight count are all read from the same instant the
 * config is rewritten from.
 *
 * Apps mid-promotion (`pending`) are excluded outright: that promise is a
 * request waiting to write.
 *
 * Nothing is restored, deleted or closed here. The app stays served, its file
 * stays on disk, reads keep working untouched — the only thing that changes
 * is that litestream stops watching it until the next statement brings it
 * back through `ensureServed`.
 */
export async function evictIdle(
  state: SyncState,
  probe: InjectedEvictionProbe,
  thresholdMs: number,
): Promise<EvictionPlan> {
  return state.withConfig(async () => {
    const now = Date.now();
    // `lastTouch` is ours, not the caller's, so the planner is handed a view
    // of it rather than boot.ts having to reach in here. It answers "has
    // anyone used this app lately", reads included — the question the write
    // counter cannot answer and `ensureServed` implicitly asks on every
    // request. See src/eviction.ts.
    const withServed: EvictionProbe = {
      ...probe,
      msSinceServed: (key) => state.msSinceTouched(key, now),
    };
    const candidates = [...state.replicated].filter((key) => {
      // Mid-promotion: that promise is a request waiting to write.
      if (state.pending.has(key)) return false;
      // Cleared to run moments ago: its statement may not have reached the
      // limiter yet, so no other check can see it. The persisted mark is a
      // valid answer here too — it is at worst one flush interval stale, and
      // staleness in this direction only KEEPS an app, which is the safe side.
      const since = state.msSinceTouched(key, now);
      return since === null || since >= EVICT_TOUCH_GRACE_MS;
    });
    const plan = planEviction(candidates, withServed, thresholdMs);
    if (plan.evict.length === 0) return plan;
    for (const key of plan.evict) state.replicated.delete(key);
    await state.litestream.apply(state.replicatedApps);
    log({
      event: "evicted",
      apps: plan.evict.length,
      // How many were freed on "watched longer than the threshold, never
      // wrote" rather than on a recorded write going stale.
      unobserved: plan.evictedUnobserved,
      stillReplicated: state.replicated.size,
      served: state.served.size,
      skipped: plan.skipped,
    });
    return plan;
  });
}
