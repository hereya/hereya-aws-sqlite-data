import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { AppWorker, WorkerPool } from "./worker-host.ts";

export function appKeyOf(orgId: string, appId: string): string {
  return `${orgId}/${appId}`;
}

/**
 * Maps (orgId, appId) to its on-disk database and worker. Layout mirrors the
 * S3 replica layout: <dbDir>/<orgId>/<appId>/app.db
 */
export class AppManager {
  private readonly cfg: Config;
  private readonly pool: WorkerPool;

  constructor(cfg: Config, pool: WorkerPool) {
    this.cfg = cfg;
    this.pool = pool;
  }

  dbPath(orgId: string, appId: string): string {
    return join(this.cfg.dbDir, orgId, appId, "app.db");
  }

  /**
   * The app's worker, held under a lease for the length of `fn`: the pool never
   * evicts it meanwhile, and a new app waits for room instead of taking a
   * worker that is about to be closed (t_worker_evict_inflight_503).
   */
  async withWorker<T>(orgId: string, appId: string, fn: (worker: AppWorker) => Promise<T>): Promise<T> {
    const path = this.dbPath(orgId, appId);
    mkdirSync(dirname(path), { recursive: true });
    return this.pool.run(appKeyOf(orgId, appId), path, fn);
  }

  async removeApp(orgId: string, appId: string): Promise<void> {
    await this.pool.remove(appKeyOf(orgId, appId));
  }

  async closeAll(): Promise<void> {
    await this.pool.closeAll();
  }

  get openApps(): number {
    return this.pool.size;
  }
}
