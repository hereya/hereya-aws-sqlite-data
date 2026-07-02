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

  workerFor(orgId: string, appId: string): AppWorker {
    const path = this.dbPath(orgId, appId);
    mkdirSync(dirname(path), { recursive: true });
    return this.pool.get(appKeyOf(orgId, appId), path);
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
