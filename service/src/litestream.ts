// Litestream lifecycle, supervised by the service itself (not systemd): the
// strict restore-then-serve boot order and hot-add both live here, in tested
// TypeScript instead of shell.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { Restorer } from "./litestream/restore.ts";

export interface LitestreamApp {
  orgId: string;
  appId: string;
  dbPath: string;
}

export type RestoreOutcome = "existing" | "restored" | "fresh";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "litestream", ...event }));
}

export class Litestream {
  private readonly cfg: Config;
  private child: ChildProcess | null = null;
  private childHealthy = false;
  private stopping = false;
  private readonly restorer: Restorer;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.restorer = new Restorer(cfg);
  }

  replicaUrl(app: LitestreamApp): string {
    return `${this.cfg.replicaBaseUrl}/${app.orgId}/${app.appId}/app.db`;
  }

  /** Restore-if-missing, one at a time per path — see litestream/restore.ts. */
  restoreIfMissing(app: LitestreamApp): Promise<RestoreOutcome> {
    return this.restorer.restoreIfMissing(app, this.replicaUrl(app));
  }

  buildConfig(apps: LitestreamApp[]): string {
    const interval = `${this.cfg.litestreamSyncIntervalMs}ms`;
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
      `l0-retention: ${this.cfg.litestreamL0Retention}`,
      `l0-retention-check-interval: ${this.cfg.litestreamL0RetentionCheckInterval}`,
      "levels:",
      ...this.cfg.litestreamLevelIntervals.map((i) => `  - interval: ${i}`),
      "snapshot:",
      `  interval: ${this.cfg.litestreamSnapshotInterval}`,
      `  retention: ${this.cfg.litestreamRetention}`,
      "dbs:",
    ];
    for (const app of apps) {
      lines.push(`  - path: ${app.dbPath}`);
      lines.push(`    replica:`);
      lines.push(`      url: ${this.replicaUrl(app)}`);
      lines.push(`      sync-interval: ${interval}`);
    }
    if (apps.length === 0) lines.push("  []");
    return lines.join("\n") + "\n";
  }

  writeConfig(apps: LitestreamApp[]): void {
    mkdirSync(dirname(this.cfg.litestreamConfigPath), { recursive: true });
    writeFileSync(this.cfg.litestreamConfigPath, this.buildConfig(apps));
  }

  /** Spec §4 step 5: start continuous replication (after the API is up). */
  start(apps: LitestreamApp[]): void {
    if (this.cfg.litestreamDisabled) return;
    this.writeConfig(apps);
    if (apps.length === 0) {
      // litestream exits immediately with no dbs; treat "nothing to replicate" as healthy
      this.childHealthy = true;
      return;
    }
    this.spawnChild();
  }

  /** Hot-add/remove: regenerate config and bounce the child (~1s pause). */
  async bounce(apps: LitestreamApp[]): Promise<void> {
    if (this.cfg.litestreamDisabled) return;
    this.writeConfig(apps);
    await this.stopChild();
    if (apps.length > 0) this.spawnChild();
    else this.childHealthy = true;
  }

  get healthy(): boolean {
    if (this.cfg.litestreamDisabled) return true;
    return this.childHealthy;
  }

  /** Pid of the running replication process, for capacity sampling; null when
   *  no child is up (disabled, no apps yet, or mid-bounce). */
  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.stopChild();
  }

  private spawnChild(): void {
    this.childHealthy = false;
    const child = spawn(this.cfg.litestreamBin, ["replicate", "-config", this.cfg.litestreamConfigPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log({ stream: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log({ stream: "stderr", text });
      // any replication error output flips health until the child proves itself again
      if (/level=ERROR|error/i.test(text)) this.childHealthy = false;
    });
    child.on("spawn", () => {
      this.childHealthy = true;
      log({ event: "replicate-started", pid: child.pid });
    });
    child.on("exit", (code, signal) => {
      this.childHealthy = false;
      if (this.child === child) this.child = null;
      log({ event: "replicate-exited", code, signal });
      // Unexpected death (not a bounce/stop): respawn with backoff — replication
      // must not stay down silently; heartbeat gates on childHealthy meanwhile.
      if (!this.stopping && !this.bouncing) {
        setTimeout(() => {
          if (!this.stopping && !this.bouncing && this.child === null) this.spawnChild();
        }, 2000).unref();
      }
    });
    child.on("error", (err) => {
      this.childHealthy = false;
      log({ event: "replicate-error", message: err.message });
    });
    this.child = child;
  }

  private bouncing = false;

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.bouncing = true;
    this.child = null;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.bouncing = false;
  }
}
