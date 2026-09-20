import type { Config } from "../config.ts";
import type { AppManager } from "../apps.ts";
import type { Registry } from "../registry.ts";
import type { TxRegistry } from "../tx.ts";
import type { Limiter } from "../limits.ts";
import type { DbQuotaGuard } from "../quota.ts";
import type { Relay } from "../relay.ts";

export interface ServerDeps {
  cfg: Config;
  registry: Registry;
  manager: AppManager;
  txRegistry: TxRegistry;
  limiter: Limiter;
  /** Org database cap. Absent = no cap is enforced (local dev, bare tests). */
  quota?: DbQuotaGuard;
  /** Restore-before-first-query hook (hot-add); absent in bare-core tests. */
  ensureServed?: (orgId: string, appId: string) => Promise<void>;
  /** Records that a statement changed this app's database. Synchronous and
   *  never throws — it runs inside every customer write. */
  recordWrite?: (orgId: string, appId: string, changed: number) => void;
  onAdminSync?: () => Promise<{ added: number; removed: number }>;
  /** Teardown hook for POST /admin/delete-app (connector drop-app flow). */
  onDeleteApp?: (orgId: string, appId: string) => Promise<void>;
  /** VM→VM relay for an app another cell holds. Absent = the 421 goes out as is. */
  relay?: Relay;
  health?: () => Record<string, unknown>;
  /** While draining (shutdown/spot notice), everything but /health gets 503. */
  isDraining?: () => boolean;
}

/** Fail-closed org/app check performed before any handler touches a database. */
export type Authorize = (orgId: string, appId: string) => Promise<void>;
