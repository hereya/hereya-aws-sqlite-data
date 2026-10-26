// The migration FENCE on the VM (Région CA — P2 lot 1c, t_rca_p2_migrate).
//
// While an org moves to another region, its registry ORG row (PK org_id, SK
// 'org') carries `migrationFreeze` — any value present = frozen. The connector
// refuses that org's writes at its own doors (dilaya-connector
// src/region-migrate/fence.ts), but a deployed per-app Lambda writes SQL HERE
// directly with its capability token: the connector is not in that loop. A
// write landing after the final delta copy would stay behind in the old region
// — silent loss. So this service refuses too, on the tenant data routes only:
//
//   * every statement that MUTATES is refused with 503 ORG_MIGRATING (the
//     connector's code and French message) and `Retry-After`. Unlike the quota,
//     DELETE / DROP / VACUUM / ANALYZE / REINDEX are writes here: the question
//     is "does the file change", not "does it grow";
//   * reads keep working (SELECT, read-only CTEs, the read-only PRAGMAs that
//     sql-guards lets through, EXPLAIN) — the migration itself reads through
//     this VM, and so do the customer's apps meanwhile;
//   * COMMIT of a transaction that wrote is refused (its statements ran before
//     the freeze; committing them after it would land past the copy). ROLLBACK
//     and BEGIN always pass. A transaction that only read commits normally;
//   * /admin routes are NOT fenced: the migration drives them.
//
// Staleness: the freeze is read with a CONSISTENT GetItem and trusted for
// `orgFenceCacheMs` (default 2 s), so a freeze bites within ~2 s on every cell.
// A write ADMITTED just before that can still be running: the migration must
// wait cache + SQL timeout after setting the freeze before its final copy.
//
// Unreadable row: FAIL OPEN, like the quota — refusing every org's writes
// because DynamoDB blinked is the worse failure — but STICKY: a failed read
// keeps the last answer this VM saw, so an org already seen frozen stays
// frozen through a registry blip (see quota/readers.ts).
import { ServiceError } from "./errors.ts";
import { IDEMPOTENT_DDL } from "./quota/policy.ts";
import { stripSqlLiterals } from "./validate.ts";

/** Verbatim from the connector (ORG_MIGRATING_MESSAGE): one voice for one state. */
export const ORG_MIGRATING_MESSAGE =
  "Cette organisation est en cours de déménagement vers une autre région : les modifications sont " +
  "suspendues pendant quelques minutes. Rien n'est perdu et vos données restent consultables ; " +
  "réessayez dans un instant.";

/** Source of an org's freeze. Never throws (see the header: fail open, sticky). */
export interface OrgFenceReader {
  migrationFrozen(orgId: string): Promise<boolean>;
}

const READ_HEAD = /^\s*\(*\s*(SELECT|EXPLAIN|PRAGMA)\b/i;
const CTE_HEAD = /^\s*\(*\s*WITH\b/i;
// A CTE may front ANY write — DELETE included, unlike the quota's list.
const CTE_WRITE = /\b(INSERT|UPDATE|REPLACE|DELETE)\b/i;

function statementReads(s: string): boolean {
  if (CTE_HEAD.test(s)) return !CTE_WRITE.test(s);
  // `CREATE TABLE IF NOT EXISTS` (no AS SELECT) is what every system table
  // runs before READING it — the same exemption the quota makes. On an existing
  // table it changes nothing; if it does create one, it is an empty table the
  // same code recreates in the new region on its first call there.
  if (IDEMPOTENT_DDL.test(s)) return !/\bSELECT\b/i.test(s);
  return READ_HEAD.test(s);
}

/** Does this SQL change the database? ONE mutating statement makes a script a write. */
export function sqlMutates(sql: string): boolean {
  const statements = stripSqlLiterals(sql)
    .split(";")
    .filter((s) => /\S/.test(s));
  return !statements.every(statementReads);
}

export class OrgFence {
  private readonly reader: OrgFenceReader;

  constructor(reader: OrgFenceReader) {
    this.reader = reader;
  }

  /** Throws ORG_MIGRATING for a write of a frozen org. A read costs nothing. */
  async assertWritable(orgId: string, mutates: boolean): Promise<void> {
    if (!mutates || !(await this.reader.migrationFrozen(orgId))) return;
    console.log(JSON.stringify({ type: "fence", ts: new Date().toISOString(), orgId, refused: true }));
    throw new ServiceError("ORG_MIGRATING", ORG_MIGRATING_MESSAGE);
  }
}
