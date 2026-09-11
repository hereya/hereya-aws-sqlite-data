/** What the sweep needs to know about one app, injected so this stays pure. */
export interface EvictionProbe {
  /** ms since the app last CHANGED its database; null = never observed. */
  idleMs: (key: string) => number | null;
  /** Is a transaction open on it? */
  hasOpenTx: (key: string) => boolean;
  /** Statements currently executing against it. */
  inFlight: (key: string) => number;
  /**
   * How long the write counter has been watching, in ms; null = it cannot say.
   *
   * Global rather than per-app, and that is the correct shape: the apps this
   * answers for are exactly the ones with no row of their own to date.
   */
  observedForMs: () => number | null;
  /**
   * ms since this instance last served a request for the app — reads included;
   * null when it has not served one since boot.
   *
   * Supplied by `AppSync`, which owns the map. Null means evictable on
   * purpose: see the header.
   */
  msSinceServed: (key: string) => number | null;
}

/**
 * The half of the probe a caller injects.
 *
 * `msSinceServed` is excluded because `AppSync` owns the map behind it and
 * fills it in itself — the type says so rather than a comment asking callers
 * to pass a placeholder they cannot compute.
 */
export type InjectedEvictionProbe = Omit<EvictionProbe, "msSinceServed">;

/** Why an app was left alone — logged, so a sweep that frees nothing explains itself. */
export type EvictionSkip =
  | "never-observed"
  | "recently-written"
  | "recently-served"
  | "open-tx"
  | "in-flight";

export interface EvictionPlan {
  evict: string[];
  skipped: Record<EvictionSkip, number>;
  /**
   * How many of `evict` were admitted on a long-enough observation rather than
   * on a recorded write — the only number that says whether that rule is doing
   * anything, and the one to watch on the first sweep after it ships.
   */
  evictedUnobserved: number;
}
