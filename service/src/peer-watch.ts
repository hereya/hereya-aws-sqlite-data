// One timer, three jobs (t_dbmove_p3_relay_cells): keep this instance's `_vms`
// row alive, put it back in discovery if a peer wrongly evicted it, and evict
// a peer that died without saying so.
//
// Why a peer has to do it. Every cell registers in the SAME Cloud Map service
// and the gateway spreads requests over all registrations, with no health
// check. A crashed instance never deregisters, so 1/N of ALL traffic — not only
// its own apps' — goes to a dead address until its replacement boots and clears
// it (~75 s measured). With one cell there was nobody else to notice.
//
// ⚠️ NO CLOCK OF ANOTHER MACHINE IS READ. A peer is dead when its `beat`
// counter has not moved across `missedTicks` of OUR observations, on OUR timer.
// Comparing its `atMs` with our `Date.now()` would work almost always, which is
// the handover's lesson about what makes a bad dependency.
//
// A wrong eviction (a live peer whose DynamoDB writes failed for a minute) costs
// little and heals itself: the peer stays reachable through the relay, and its
// next tick finds `evicted` on its own row and registers again.
import type { VmDirectory, VmIdentity, VmRow } from "./vms.ts";

export interface PeerWatchDeps {
  directory: Pick<VmDirectory, "readAll" | "put" | "remove">;
  self: VmIdentity;
  /** Cloud Map: remove a peer's registration / put our own back. */
  deregisterPeer: (instanceId: string) => Promise<void>;
  registerSelf: () => Promise<void>;
  /** Ticks a peer's counter may stand still before it is declared dead. */
  missedTicks?: number;
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "peer-watch", ...event }));
}

export class PeerWatch {
  private readonly deps: PeerWatchDeps;
  private readonly missedTicks: number;
  private beat = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  /** instanceId → the last counter WE read, and how many ticks it has stood still. */
  private readonly seen = new Map<string, { beat: number; still: number }>();

  constructor(deps: PeerWatchDeps) {
    this.deps = deps;
    this.missedTicks = deps.missedTicks ?? 3;
  }

  /** The first announcement is awaited by the boot: a cell nobody can find is not serving. */
  async announce(): Promise<void> {
    const { self, directory } = this.deps;
    await directory.put(self, "serving", this.beat);
    log({ event: "announced", ...self });
    // "Clear MY cell's leftovers", as cloudmap.ts does and at the same moment:
    // we announce only once our predecessor has stopped (or was terminated), so
    // any other row of this cell is a past instance. Best effort — a leftover
    // costs a peer one refused connection, not a wrong answer.
    try {
      for (const row of await directory.readAll()) {
        if (row.cellId === self.cellId && row.instanceId !== self.instanceId) await directory.remove(row);
      }
    } catch (err) {
      log({ event: "cleanup-failed", message: (err as Error).message });
    }
  }

  start(periodMs: number): void {
    this.timer = setInterval(() => void this.tick(), periodMs);
    this.timer.unref();
  }

  /** Drain: say so, so that peers stop relaying here before the port closes. */
  async retire(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await this.deps.directory.put(this.deps.self, "retired", this.beat);
      log({ event: "retired", instanceId: this.deps.self.instanceId });
    } catch (err) {
      log({ event: "retire-failed", message: (err as Error).message });
    }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    let rows: VmRow[];
    try {
      rows = await this.deps.directory.readAll();
    } catch (err) {
      // Blind = no judgement. Counting a tick we could not see as "stood still"
      // would let OUR DynamoDB trouble evict healthy peers.
      log({ event: "read-failed", message: (err as Error).message });
      return;
    }
    const { self } = this.deps;
    const mine = rows.find((r) => r.instanceId === self.instanceId);
    try {
      if (mine?.state === "evicted") {
        await this.deps.registerSelf();
        log({ event: "self-healed", instanceId: self.instanceId });
      }
      if (this.stopped) return;
      this.beat += 1;
      await this.deps.directory.put(self, "serving", this.beat);
    } catch (err) {
      log({ event: "beat-failed", message: (err as Error).message });
    }
    await this.judge(rows.filter((r) => r.instanceId !== self.instanceId && r.state === "serving"));
  }

  private async judge(peers: VmRow[]): Promise<void> {
    const live = new Set(peers.map((p) => p.instanceId));
    for (const id of this.seen.keys()) if (!live.has(id)) this.seen.delete(id);
    for (const peer of peers) {
      const prev = this.seen.get(peer.instanceId);
      const still = prev !== undefined && prev.beat === peer.beat ? prev.still + 1 : 0;
      this.seen.set(peer.instanceId, { beat: peer.beat, still });
      if (still < this.missedTicks) continue;
      try {
        await this.deps.deregisterPeer(peer.instanceId);
        await this.deps.directory.put(peer, "evicted", peer.beat);
        this.seen.delete(peer.instanceId);
        log({ event: "evicted-dead-peer", cellId: peer.cellId, instanceId: peer.instanceId, stillTicks: still });
      } catch (err) {
        log({ event: "evict-failed", instanceId: peer.instanceId, message: (err as Error).message });
      }
    }
  }
}
