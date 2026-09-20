import type { AppManager } from "../apps.ts";
import type { EvictionPlan, InjectedEvictionProbe } from "../eviction.ts";
import type { Litestream, LitestreamApp } from "../litestream.ts";
import type { Registry } from "../registry.ts";
import { bootRestoreAll } from "./boot-restore.ts";
import { ensureServed } from "./ensure-served.ts";
import { evictIdle } from "./evict.ts";
import { doSync, removeApp } from "./reconcile.ts";
import { SyncState } from "./state.ts";
import type { TouchSink } from "./touch-sink.ts";

/**
 * Owns the "served set": which apps have a restored local db and are covered
 * by the litestream config. Reconciles it against the registry at boot, on the
 * poll interval, on /admin/sync, and on-demand when a request hits an app the
 * registry knows but this instance doesn't serve yet (hot-add without restart).
 *
 * The set itself — and the two things that must never be read apart from it,
 * the config lock and the last-used view — lives in ./state.ts; each operation
 * below carries its own reasoning in the module it points at.
 */
export class AppSync {
  private readonly state: SyncState;
  private syncing: Promise<{ added: number; removed: number }> | null = null;

  constructor(registry: Registry, manager: AppManager, litestream: Litestream, concurrency = 8) {
    this.state = new SyncState(registry, manager, litestream, concurrency);
  }

  /**
   * Attach the durable touch store. Optional: without it every behaviour below
   * is exactly what it was before, which is what keeps the file registry and
   * the unit tests free of a DynamoDB dependency.
   */
  setTouchSink(sink: TouchSink): void {
    this.state.touchSink = sink;
  }

  /** Spec §4 steps 2-3: restore every active app BEFORE the API binds. See ./boot-restore.ts. */
  async bootRestoreAll(): Promise<LitestreamApp[]> {
    return bootRestoreAll(this.state);
  }

  /** Every app this instance can answer queries for. */
  get servedApps(): LitestreamApp[] {
    return this.state.servedApps;
  }

  /** The apps litestream watches — what `buildConfig` must be given. */
  get replicatedApps(): LitestreamApp[] {
    return this.state.replicatedApps;
  }

  /** How many served apps are deliberately NOT replicated (never written). */
  get unusedCount(): number {
    return this.state.unusedCount;
  }

  /** The local file predates this boot (a process restart). See handover/catchup.ts. */
  hadLocalFileAtBoot(orgId: string, appId: string): boolean {
    return this.state.existingAtBoot.has(`${orgId}/${appId}`);
  }

  isServed(orgId: string, appId: string): boolean {
    return this.state.isServed(orgId, appId);
  }

  /** Request-path hot-add and promotion gate. See ./ensure-served.ts. */
  async ensureServed(orgId: string, appId: string): Promise<void> {
    return ensureServed(this.state, orgId, appId);
  }

  /** Drop every app quiet for `thresholdMs` from the config. See ./evict.ts. */
  async evictIdle(probe: InjectedEvictionProbe, thresholdMs: number): Promise<EvictionPlan> {
    return evictIdle(this.state, probe, thresholdMs);
  }

  /** Explicit teardown (connector drop-app flow). See ./reconcile.ts. */
  async removeApp(orgId: string, appId: string): Promise<void> {
    return removeApp(this.state, orgId, appId);
  }

  /** Full reconcile: registry is the source of truth for adds AND removals. */
  async syncOnce(): Promise<{ added: number; removed: number }> {
    if (this.syncing) return this.syncing;
    this.syncing = doSync(this.state).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
}
