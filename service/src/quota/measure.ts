// Measure, don't accumulate. Usage is the real size of the org's files on this
// disk — no ledger to drift out of sync. Paths are resolved from the caller's
// `dbDir`, never from this file's own location.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Total bytes of every database this VM holds for the org.
 *
 * MAIN FILE ONLY — deliberately NOT the same accounting as GET /stats, which
 * adds the WAL because it reports "what is this app using right now". A cap
 * must not count the WAL, for one decisive reason: in WAL mode `VACUUM`
 * rewrites the entire database THROUGH the WAL, so the single statement that
 * frees space would briefly double the measured usage — the way out would
 * register as growth and keep the customer locked in. The WAL is a transient
 * buffer anyway (SQLite auto-checkpoints it), so the
 * main file is both the stabler and the more honest number.
 *
 * The instance restores EVERY active app at boot (see AppSync.bootRestoreAll),
 * so this sum is the org's whole footprint. Were the service ever sharded
 * across instances it would UNDER-count, which is the safe direction: it can
 * only fail to refuse, never refuse someone who is under their cap.
 */
export function measureOrgDbBytes(dbDir: string, orgId: string): number {
  let entries;
  try {
    entries = readdirSync(join(dbDir, orgId), { withFileTypes: true });
  } catch {
    return 0; // org has nothing on disk yet
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      total += statSync(join(dbDir, orgId, entry.name, "app.db")).size;
    } catch {
      // absent (app never written to) — counts as 0
    }
  }
  return total;
}
