// Litestream lifecycle, supervised by the service itself (not systemd): the
// strict restore-then-serve boot order and hot-add both live here, in tested
// TypeScript instead of shell.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { buildLitestreamConfig } from "./litestream/config-file.ts";
import { ControlSocket, diffWatched, maxLagSeconds, pooled } from "./litestream/control.ts";
import { Restorer } from "./litestream/restore.ts";

export interface LitestreamApp {
  orgId: string;
  appId: string;
  dbPath: string;
}

export type RestoreOutcome = "existing" | "restored" | "fresh";

/** Past this many changes at once, one ~1 s bounce beats that many socket
 *  commands run under the config lock. */
const SOCKET_MAX_CHANGES = 32;

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "litestream", ...event }));
}

export class Litestream {
  private readonly cfg: Config;
  private child: ChildProcess | null = null;
  private childHealthy = false;
  private stopping = false;
  private readonly restorer: Restorer;
  private readonly control: ControlSocket | null;
  /** What the daemon was last told to watch, by db path — `apply` diffs against it. */
  private watched = new Map<string, LitestreamApp>();

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.restorer = new Restorer(cfg);
    this.control = cfg.litestreamSocketPath ? new ControlSocket(cfg.litestreamBin, cfg.litestreamSocketPath) : null;
  }

  /** The worst per-database replication lag, in seconds (control.ts); null = nothing to say. Never throws. */
  async replicationLagSeconds(): Promise<number | null> {
    if (!this.control || !this.child) return null;
    return this.control.lastSyncs().then((entries) => maxLagSeconds(entries, Date.now()), () => null);
  }

  replicaUrl(app: LitestreamApp): string {
    return `${this.cfg.replicaBaseUrl}/${app.orgId}/${app.appId}/app.db`;
  }

  /** Restore-if-missing, one at a time per path — see litestream/restore.ts. */
  restoreIfMissing(app: LitestreamApp): Promise<RestoreOutcome> {
    return this.restorer.restoreIfMissing(app, this.replicaUrl(app));
  }

  buildConfig(apps: LitestreamApp[]): string {
    return buildLitestreamConfig(this.cfg, apps, (app) => this.replicaUrl(app));
  }

  writeConfig(apps: LitestreamApp[]): void {
    mkdirSync(dirname(this.cfg.litestreamConfigPath), { recursive: true });
    writeFileSync(this.cfg.litestreamConfigPath, this.buildConfig(apps));
    this.watched = new Map(apps.map((app) => [app.dbPath, app]));
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

  /**
   * Hot-add/remove: make the daemon watch exactly `apps`, touching ONLY the
   * databases that join or leave — through the control socket, so replication
   * of every other database carries on (a bounce suspends all of them ~1 s).
   *
   * The config file is still written first: it is what a cold start and the
   * respawn-after-crash read, and it is what makes the fallback safe — whatever
   * the socket did or did not do, a bounce converges on the file. Callers hold
   * `SyncState.withConfig`, exactly as they did for `bounce`.
   */
  async apply(apps: LitestreamApp[]): Promise<void> {
    if (this.cfg.litestreamDisabled) return;
    const { added, removed } = diffWatched(this.watched, apps);
    const changes = added.length + removed.length;
    // No daemon yet, or none wanted (on an empty list it logs ERROR and idles):
    // starting or stopping it disturbs nobody.
    if (!this.control || !this.child || apps.length === 0 || changes > SOCKET_MAX_CHANGES) {
      return this.bounce(apps);
    }
    const control = this.control;
    this.writeConfig(apps);
    try {
      await control.ready();
      await pooled(removed, (app) => control.remove(app));
      await pooled(added, (app) => control.register(app, this.replicaUrl(app)));
      log({ event: "socket-applied", added: added.length, removed: removed.length });
    } catch (err) {
      log({ event: "socket-fallback", message: (err as Error).message });
      await this.bounce(apps);
    }
  }

  /**
   * Let go of ONE database for a move: final sync, observed stop, unregister.
   * Unlike `apply` there is NO bounce fallback — a bounce stops the database
   * too, but nobody observes that its last frames reached the replica, and the
   * target cell is about to restore from it. A failure here throws, the mover
   * aborts, and `bounce` is how the caller converges afterwards.
   * Returns false when the daemon was not watching it (nothing to hand off).
   */
  async detachOne(app: LitestreamApp, remaining: LitestreamApp[]): Promise<boolean> {
    if (this.cfg.litestreamDisabled || !this.watched.has(app.dbPath)) return false;
    if (!this.control || !this.child) throw new Error("no control socket: a move needs an observed per-database stop");
    await this.control.ready();
    await this.control.handOff(app);
    this.writeConfig(remaining);
    log({ event: "socket-detached", orgId: app.orgId, appId: app.appId });
    return true;
  }

  /** The whole-process restart `apply` falls back to (~1s pause for every db). */
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
