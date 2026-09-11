import type { Config } from "../config.ts";
import { DdbOrgQuotaReader, StaticOrgQuotaReader, type OrgQuotaReader } from "../quota.ts";
import { DdbRegistry, FileRegistry, type Registry } from "../registry.ts";

export function createRegistry(cfg: Config): Registry {
  if (cfg.registryMode === "file") return new FileRegistry(cfg.registryFile);
  return new DdbRegistry({ tableName: cfg.registryTable, region: cfg.awsRegion, cacheMs: cfg.registryCacheMs });
}

/**
 * Where org caps come from. In file (local-dev) mode there is no org row to
 * read and nothing to bill, so nothing is capped.
 */
export function createOrgQuotaReader(cfg: Config): OrgQuotaReader {
  if (cfg.registryMode === "file") return new StaticOrgQuotaReader();
  return new DdbOrgQuotaReader({
    tableName: cfg.registryTable,
    region: cfg.awsRegion,
    cacheMs: cfg.orgQuotaCacheMs,
  });
}
