import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

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

/**
 * A raw DynamoDB client for the handover records.
 *
 * Deliberately its own client rather than one borrowed from the registry: the
 * registry wraps caching and shape-mapping the handover must not inherit — a
 * cached read of "has my predecessor stopped yet" would answer from before the
 * question was asked. Returns null in file (local-dev) mode, where there is no
 * table and the handover is not available.
 */
export function createHandoverClient(cfg: Config): DynamoDBClient | null {
  if (cfg.registryMode !== "ddb" || !cfg.registryTable) return null;
  return new DynamoDBClient({ region: cfg.awsRegion });
}
