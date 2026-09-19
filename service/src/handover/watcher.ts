// The departing instance's side: notice that a replacement is warming up, and
// remember what the write counter held at that moment.
//
// It exists because the two halves of the catch-up list live on different
// machines. The replacement knows WHEN it began warming; the departing instance
// knows WHICH apps were written. Neither can be shipped to the other as a
// timestamp without comparing two clocks (see record.ts and dirty.ts), so the
// departing instance observes the announcement itself and takes its own
// snapshot at that instant. Everything it then compares is its own.
//
// It is an OPTIMISATION, never a correctness requirement. If this watcher never
// runs, never sees anything, or dies, `snapshot` stays null, the shutdown
// publishes `dirtyUnknown`, and the replacement re-restores every app it holds:
// slower, still correct. That is why nothing here throws and why the poll is
// cheap and unhurried.
import type { WriteStat } from "../write-stats/stat.ts";
import { acknowledgeWarming } from "./ack.ts";
import { snapshotWrites, type WriteCounts } from "./dirty.ts";
import { observeWarming, type HandoverDeps } from "./protocol.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

export class WarmingWatcher {
  private readonly deps: HandoverDeps;
  private readonly selfInstanceId: string;
  private readonly readStats: () => ReadonlyMap<string, WriteStat>;
  private timer: NodeJS.Timeout | null = null;
  /** The write counts when a replacement was FIRST seen; null = never seen. */
  private snapshot: WriteCounts | null = null;
  /**
   * The replacement we last told we are alive (see ack.ts). An id, not a flag:
   * a first replacement can be abandoned by the ASG and a SECOND one launched,
   * and a second one left un-acked would conclude that nobody is here.
   */
  private ackedFor: string | null = null;

  constructor(opts: {
    deps: HandoverDeps;
    selfInstanceId: string;
    readStats: () => ReadonlyMap<string, WriteStat>;
  }) {
    this.deps = opts.deps;
    this.selfInstanceId = opts.selfInstanceId;
    this.readStats = opts.readStats;
  }

  /** What the counter held when the window opened, or null if it never did. */
  get windowSnapshot(): WriteCounts | null {
    return this.snapshot;
  }

  /**
   * One poll. Keeps the FIRST observation and never revises it: a later
   * snapshot would sit after writes that the replacement's copy already
   * missed, and those are exactly the ones the list must carry.
   */
  async tick(): Promise<void> {
    try {
      if (this.snapshot === null) {
        const seenAt = await observeWarming(this.deps, { selfInstanceId: this.selfInstanceId });
        if (seenAt === null) return;
        this.snapshot = snapshotWrites(this.readStats());
        log({ event: "replacement-warming", apps: this.snapshot.size });
      }
      // SNAPSHOT FIRST, ACK SECOND: the ack is what lets the replacement trust
      // our dirty list, so it must never exist before the snapshot it vouches
      // for. Retried on later ticks until it lands — the snapshot is not: it stays
      // the FIRST one, which for a second replacement is merely a wider window.
      const acked = await acknowledgeWarming(this.deps, {
        selfInstanceId: this.selfInstanceId,
        alreadyAcked: this.ackedFor,
      });
      if (acked !== null && acked !== this.ackedFor) {
        this.ackedFor = acked;
        log({ event: "acknowledged", replacement: acked });
      }
    } catch {
      // A watcher that cannot look is indistinguishable from one that saw
      // nothing, and both lead to the same safe answer: dirtyUnknown.
    }
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
