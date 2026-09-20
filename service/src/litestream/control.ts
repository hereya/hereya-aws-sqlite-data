// Litestream's control socket: add or drop ONE database on the running daemon
// instead of restarting it. Split out of litestream.ts (220-line cap).
//
// Driven through the pinned binary's own subcommands (`register`, `stop`,
// `unregister`) rather than by speaking HTTP to the socket ourselves: the CLI
// is the documented surface, the wire format behind it is not.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LitestreamApp } from "../litestream.ts";

/** A unix socket path is capped by `sockaddr_un` (104 bytes on macOS, 108 on
 *  linux); past it the daemon fails with `bind: invalid argument`. */
export const SOCKET_PATH_MAX = 100;

/** Seconds a single socket command may take before the caller falls back.
 *  `stop` waits for the final sync, so this bounds how long a slow S3 can hold
 *  the config lock — after which the bounce takes over, as it always did. */
const COMMAND_TIMEOUT_S = 10;

/** How long a freshly spawned daemon is given to open its socket (measured:
 *  ~100 ms). Without this, every promotion of the wave that follows a roll
 *  would find no socket yet and bounce — the very thing being removed. */
const SOCKET_READY_MS = 3000;

/**
 * Where the socket lives: beside the config file, which the service user
 * already owns — so enabling it needs nothing from the infra. `off` (or a path
 * too long to bind) disables it, and every change goes back to the bounce.
 */
export function resolveSocketPath(env: string | undefined, configPath: string): string {
  if (env === "off") return "";
  const path = env ?? join(dirname(configPath), "litestream.sock");
  return path.length > SOCKET_PATH_MAX ? "" : path;
}

export class ControlSocket {
  private readonly bin: string;
  private readonly path: string;

  constructor(bin: string, path: string) {
    this.bin = bin;
    this.path = path;
  }

  /** Wait for the daemon to have created its socket; throws if it never does. */
  async ready(): Promise<void> {
    const deadline = Date.now() + SOCKET_READY_MS;
    while (!existsSync(this.path)) {
      if (Date.now() >= deadline) throw new Error(`control socket not listening: ${this.path}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Start replicating one more database. Idempotent (`already_registered`). */
  register(app: LitestreamApp, replicaUrl: string): Promise<void> {
    return this.run("register", ["-replica", replicaUrl], app.dbPath);
  }

  /**
   * Stop watching one database. `stop` "always waits for shutdown and final
   * sync" — it is what makes the removal OBSERVED rather than assumed — and
   * `unregister` then forgets the database. Both are idempotent.
   */
  async remove(app: LitestreamApp): Promise<void> {
    await this.run("stop", [], app.dbPath);
    await this.run("unregister", [], app.dbPath);
  }

  /**
   * What a MOVE needs and a removal does not: the replica provably holds every
   * frame before the database is stopped. `stop` already waits for a final
   * sync; `sync -wait` first makes that a fact we asked for, not one we infer.
   */
  async handOff(app: LitestreamApp): Promise<void> {
    await this.run("sync", ["-wait"], app.dbPath);
    await this.remove(app);
  }

  private run(command: string, options: string[], dbPath: string): Promise<void> {
    const args = [command, ...options, "-timeout", String(COMMAND_TIMEOUT_S), "-socket", this.path, dbPath];
    return new Promise<void>((resolve, reject) => {
      execFile(this.bin, args, { timeout: (COMMAND_TIMEOUT_S + 2) * 1000 }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        reject(new Error(`litestream ${command} failed: ${stderr.trim() || err.message}`));
      });
    });
  }
}

/** Run `task` over `items`, 8 at a time (the boot restore's width); rejects on
 *  the first failure. */
export async function pooled<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
}

/** What must join and what must leave for the daemon to watch exactly `apps`. */
export function diffWatched(
  watched: ReadonlyMap<string, LitestreamApp>,
  apps: LitestreamApp[],
): { added: LitestreamApp[]; removed: LitestreamApp[] } {
  const wanted = new Set(apps.map((app) => app.dbPath));
  return {
    added: apps.filter((app) => !watched.has(app.dbPath)),
    removed: [...watched.values()].filter((app) => !wanted.has(app.dbPath)),
  };
}
