/**
 * The durable side of "when was this app last used".
 *
 * Deliberately narrower than `WriteStats`, which is what implements it in
 * production: `AppSync` has no business knowing about DynamoDB, counters or
 * flush timers, and the unit tests get a two-method stub instead of a fake
 * cloud. Both methods must be synchronous and non-throwing — `recordTouch`
 * runs on the read path of every customer request.
 */
export interface TouchSink {
  /** Someone used this app, at `atMs`. Memory only; persistence is the sink's. */
  recordTouch(key: string, atMs: number): void;
  /** Milliseconds since the last persisted access; null when never seen. */
  msSinceTouch(key: string): number | null;
}
