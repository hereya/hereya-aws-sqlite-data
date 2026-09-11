/**
 * How long after a request was cleared to run an app stays un-evictable.
 *
 * `AppSync.ensureServed` returns before the caller acquires its limiter slot,
 * so for a brief moment a statement is authorised to write while `inFlight` is
 * still zero — invisible to every other guard here. This grace covers that gap.
 * It must comfortably exceed a statement's own lifetime (`sqlTimeoutMs`, 1.5-30 s);
 * five minutes is generous on purpose, and free, because the threshold it defers
 * to is measured in days.
 */
export const EVICT_TOUCH_GRACE_MS = 5 * 60 * 1000;

/** Days → ms, the unit the threshold is actually reasoned about in. */
export function daysToMs(days: number): number {
  return days > 0 ? Math.round(days * 24 * 60 * 60 * 1000) : 0;
}
