// Shared stand-ins for the eviction tests: the injected probe, and the fake
// litestream/registry/manager the `AppSync` integration tests drive.
import type { Litestream, LitestreamApp, RestoreOutcome } from "../../../src/litestream.ts";
import type { EvictionProbe } from "../../../src/eviction.ts";
import type { Registry } from "../../../src/registry.ts";
import type { AppManager } from "../../../src/apps.ts";

export const DAY = 24 * 60 * 60 * 1000;

export function probeOf(
  idle: Record<string, number | null>,
  openTx: string[] = [],
  inFlight: Record<string, number> = {},
  observedForMs: number | null = null,
  served: Record<string, number> = {},
): EvictionProbe {
  return {
    idleMs: (key) => (key in idle ? idle[key]! : null),
    hasOpenTx: (key) => openTx.includes(key),
    inFlight: (key) => inFlight[key] ?? 0,
    // Null by default: a counter that cannot date itself knows nothing, which
    // is the state every test below other than the maturity ones assumes.
    observedForMs: () => observedForMs,
    // Null = not served since boot, the state a fresh instance is in. `AppSync`
    // overrides this from its own map when it calls the planner.
    msSinceServed: (key) => served[key] ?? null,
  };
}

export function fakeLitestream(opts: { onBounce?: (apps: LitestreamApp[]) => Promise<void> | void } = {}) {
  const configs: string[][] = [];
  const ls = {
    async restoreIfMissing(): Promise<RestoreOutcome> {
      return "restored";
    },
    async apply(apps: LitestreamApp[]) {
      // Snapshot BEFORE any awaiting the hook does, exactly like the real
      // implementation writing the config file from its argument.
      const snapshot = apps.map((a) => a.appId).sort();
      await opts.onBounce?.(apps);
      configs.push(snapshot);
    },
  } as unknown as Litestream;
  return { ls, configs, lastConfig: () => configs[configs.length - 1] ?? null };
}

export const manager = {
  dbPath: (o: string, a: string) => `/dbs/${o}/${a}/app.db`,
  async removeApp() {},
} as unknown as AppManager;

export const registryOf = (ids: string[]) =>
  ({ listActive: async () => ids.map((appId) => ({ orgId: "org", appId })) }) as unknown as Registry;
