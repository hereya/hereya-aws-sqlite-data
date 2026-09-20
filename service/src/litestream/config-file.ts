// The litestream config file, as text. Split out of litestream.ts (220-line cap).
import type { Config } from "../config.ts";
import type { LitestreamApp } from "../litestream.ts";

export function buildLitestreamConfig(cfg: Config, apps: LitestreamApp[], replicaUrl: (app: LitestreamApp) => string): string {
  const interval = `${cfg.litestreamSyncIntervalMs}ms`;
  // 0.5.x schema: snapshots are configured globally (per-db values must not
  // conflict anyway), and each db takes a single `replica:` — the legacy
  // replica-level `retention:`/`snapshot-interval:` keys are silently
  // IGNORED by 0.5.x (config parsing is non-strict), so keeping them would
  // shrink the restore window to the 24h defaults without any error.
  // Housekeeping cadences are declared explicitly rather than left to the
  // built-in defaults: they are fixed per-database timers that LIST the
  // replica on every tick regardless of whether the database was written to,
  // and they — not the writes — are what the S3 request bill is made of.
  // They do NOT affect the loss window (that is `sync-interval`, per-replica
  // below); slowing them only delays the merge of L0 files, i.e. costs
  // restore speed.
  const lines: string[] = [
    `l0-retention: ${cfg.litestreamL0Retention}`,
    `l0-retention-check-interval: ${cfg.litestreamL0RetentionCheckInterval}`,
    "levels:",
    ...cfg.litestreamLevelIntervals.map((i) => `  - interval: ${i}`),
    "snapshot:",
    `  interval: ${cfg.litestreamSnapshotInterval}`,
    `  retention: ${cfg.litestreamRetention}`,
  ];
  if (cfg.litestreamSocketPath) {
    lines.push("socket:", "  enabled: true", `  path: ${cfg.litestreamSocketPath}`);
  }
  lines.push("dbs:");
  for (const app of apps) {
    lines.push(`  - path: ${app.dbPath}`);
    lines.push(`    replica:`);
    lines.push(`      url: ${replicaUrl(app)}`);
    lines.push(`      sync-interval: ${interval}`);
  }
  if (apps.length === 0) lines.push("  []");
  return lines.join("\n") + "\n";
}
