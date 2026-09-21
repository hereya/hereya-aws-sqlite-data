// Graceful shutdown: on SIGTERM or a Spot interruption notice, stop taking
// requests (503 → callers retry politely), roll back open transactions,
// give litestream a final sync window, then exit. Narrows the loss window on clean interruptions to ~zero.
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import type { AppManager } from "./apps.ts";
import type { AppSync } from "./sync.ts";
import type { CloudMapRegistration } from "./cloudmap.ts";
import type { Litestream } from "./litestream.ts";
import type { TxRegistry } from "./tx.ts";
import type { PeerWatch } from "./peer-watch.ts";
import type { WarmingWatcher } from "./handover/watcher.ts";
import type { WriteStats } from "./write-stats.ts";
import { dirtySince } from "./handover/dirty.ts";
import { publishHandover, type HandoverDeps } from "./handover/protocol.ts";
import { clearWriter } from "./handover/writer-marker.ts";

const IMDS_BASE = "http://169.254.169.254";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "shutdown", ...event }));
}

export class Shutdown {
  private readonly cfg: Config;
  private readonly server: Server;
  private readonly manager: AppManager;
  private readonly sync: AppSync;
  private readonly litestream: Litestream;
  private readonly txRegistry: TxRegistry;
  private readonly cloudMap: CloudMapRegistration | null;
  private readonly peerWatch: PeerWatch | null;
  private readonly watcher: WarmingWatcher | null;
  /** Null when the handover is off — every call site then short-circuits. */
  private readonly handover: (HandoverDeps & { instanceId: string }) | null;
  private readonly writeStats: WriteStats | null;
  private draining = false;
  private spotTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    cfg: Config;
    server: Server;
    manager: AppManager;
    sync: AppSync;
    litestream: Litestream;
    txRegistry: TxRegistry;
    cloudMap?: CloudMapRegistration | null;
    peerWatch?: PeerWatch | null;
    watcher?: WarmingWatcher | null;
    handover?: (HandoverDeps & { instanceId: string }) | null;
    writeStats?: WriteStats | null;
  }) {
    this.cfg = opts.cfg;
    this.server = opts.server;
    this.manager = opts.manager;
    this.sync = opts.sync;
    this.litestream = opts.litestream;
    this.txRegistry = opts.txRegistry;
    this.cloudMap = opts.cloudMap ?? null;
    this.peerWatch = opts.peerWatch ?? null;
    this.watcher = opts.watcher ?? null;
    this.handover = opts.handover ?? null;
    this.writeStats = opts.writeStats ?? null;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  install(): void {
    process.on("SIGTERM", () => void this.begin("SIGTERM"));
    process.on("SIGINT", () => void this.begin("SIGINT"));
    if (this.cfg.imdsEnabled) this.watchSpotNotice();
  }

  /** Poll IMDSv2 for the 2-minute Spot interruption notice. */
  private watchSpotNotice(): void {
    const poll = async (): Promise<void> => {
      try {
        const tokenRes = await fetch(`${IMDS_BASE}/latest/api/token`, {
          method: "PUT",
          headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
          signal: AbortSignal.timeout(2000),
        });
        if (!tokenRes.ok) return;
        const token = await tokenRes.text();
        const res = await fetch(`${IMDS_BASE}/latest/meta-data/spot/instance-action`, {
          headers: { "X-aws-ec2-metadata-token": token },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          log({ event: "spot-interruption-notice" });
          void this.begin("spot-interruption");
        }
      } catch {
        // IMDS unreachable — not our signal to act on
      }
    };
    this.spotTimer = setInterval(() => void poll(), 5000);
    this.spotTimer.unref();
  }

  /**
   * Tell the replacement we have stopped, and which databases moved while it
   * warmed up.
   *
   * The list comes from the snapshot the watcher took when it first saw the
   * replacement announce itself, compared against the counter now — both read
   * on THIS machine. No snapshot (no watcher, or it never saw anything) means
   * we cannot delimit the window, so we say so: `null` publishes
   * `dirtyUnknown` and the replacement re-restores everything. Slow, correct.
   */
  private async handOver(): Promise<void> {
    if (!this.handover) return;
    const snapshot = this.watcher?.windowSnapshot ?? null;
    const dirty =
      snapshot === null || this.writeStats === null
        ? null
        : dirtySince(snapshot, this.writeStats.snapshot());
    await publishHandover(this.handover, { instanceId: this.handover.instanceId, dirtyApps: dirty });
  }

  async begin(reason: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    log({ event: "drain-start", reason });
    if (this.spotTimer) clearInterval(this.spotTimer);

    // 0. Leave service discovery first so API Gateway stops routing to us.
    // …and the peers' directory, so that they stop relaying to us as well.
    if (this.cloudMap) await this.cloudMap.deregister();
    await this.peerWatch?.retire();

    // 1. Roll back whatever transactions are open (their callers get TX_NOT_FOUND).
    for (const app of this.sync.servedApps) {
      const appKey = `${app.orgId}/${app.appId}`;
      if (!this.txRegistry.hasOpenTx(appKey)) continue;
      this.txRegistry.deleteByAppKey(appKey);
      try {
        await this.manager.withWorker(app.orgId, app.appId, (w) => w.control("rollback", this.cfg.txOpTimeoutMs));
      } catch {
        // worker may already be gone; WAL semantics roll it back regardless
      }
    }

    // 2. Let in-flight requests finish (bounded), while new ones get 503.
    await new Promise((r) => setTimeout(r, this.cfg.drainMs));

    // 3. (REMOVED 2026-09-19, t_handover_catchup_parallel) There used to be a
    // `PRAGMA wal_checkpoint(TRUNCATE)` per served app here, one after another.
    // TRUNCATE needs every reader gone, and litestream holds a read transaction
    // on each database it replicates: measured at 100 apps, EVERY one blocked
    // its full 5 s and failed. 500 s of drain, cut by systemd's SIGKILL at 90 s
    // — so steps 4 and 4-bis below never ran: no final sync window, no clean
    // litestream stop, no handover report (the 132 s of the 19/09 prod roll).
    // It also bought nothing: litestream ships WAL frames, it does not need
    // the WAL folded into the main file. Do not bring a per-app step back into
    // this path — everything here is outage, and must not grow with the fleet.

    // 4. Final replication window, then stop litestream cleanly.
    await new Promise((r) => setTimeout(r, this.cfg.litestreamSyncIntervalMs * 2));
    await this.litestream.stop();
    // No longer the writer — said BEFORE the report below hands the role over
    // (handover/writer-marker.ts). If that cannot be said, no report: better a
    // slow roll than a restart of ours that starts a second writer.
    const released = clearWriter(this.cfg.dbDir);

    // 4-bis. HAND OVER (t_vm_zero_cut_handover) — only ever AFTER the line
    // above, because `stop()` waits for the litestream child to EXIT and the
    // report asserts exactly that. Publishing earlier would assert something
    // untrue and invite the replacement to start replicating while we still
    // were. Everything here is best-effort: a dying process must still die.
    if (released) await this.handOver();

    await this.manager.closeAll();
    this.server.close();
    log({ event: "drain-complete", reason });
    process.exit(0);
  }
}
