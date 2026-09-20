// The replacement's side of the handover, as one call the boot can make.
//
// ⚠️ WHERE THIS RUNS IS THE WHOLE SAFETY PROPERTY: after the HTTP port binds
// (harmless — nothing routes to us until Cloud Map registration) and **before
// `litestream.start()`**. Starting replication earlier is precisely the
// dual-writer the ASG's terminate-before-launch exists to prevent: for the
// seconds it took the old instance to drain, two processes would be shipping
// LTX to one generation path. Moving this call below `litestream.start()`
// would look like a harmless reordering and would be the worst bug in the
// package.
import type { Config } from "../config.ts";
import { awaitAck } from "./ack.ts";
import { catchUp, type CatchUpDeps } from "./catchup.ts";
import { awaitPredecessorStop, type StopOutcome } from "./overlap.ts";
import { awaitHandover } from "./protocol.ts";
import type { HandoverRecord } from "./record.ts";
import type { HandoverDeps } from "./protocol.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

export interface GateDeps extends HandoverDeps {
  instanceId: string;
  /**
   * What `announceWarming` returned — and it must have been called BEFORE the
   * restore, not here. The announcement is what opens the window the departing
   * instance reports on, so announcing after the restore would leave every
   * write of those ~21.5 s outside the catch-up list: already missed by our
   * copy, and never named as dirty. That is precisely the staleness this whole
   * mechanism exists to prevent, so the baseline is passed IN rather than
   * taken here — a gate that could announce for itself could announce late.
   */
  baseline: HandoverRecord | null;
  /** When `announceWarming` ran, on THIS machine's clock — the ack deadline is
   *  counted from it, so the restore absorbs the wait instead of adding to it. */
  announcedAtMs: number;
  /** The `atMs` this boot wrote in its announcement — an ack must echo it (ack.ts). */
  announceId: number;
  /**
   * Release the ASG launch hook (lifecycle.ts). Called once we are warm and
   * BEFORE waiting for the report — it is what gets the predecessor its
   * SIGTERM, so waiting first would be waiting for something we are blocking.
   */
  completeLaunch: () => Promise<unknown>;
  /** The other instances of our ASG (overlap.ts); null = could not tell. */
  peers: () => Promise<string[] | null>;
  /** Every app this instance restored — the fallback list when the departing
   *  instance could not say which ones moved. */
  servedKeys: () => string[];
  catchUpDeps: CatchUpDeps;
}

/**
 * Wait for the previous instance to prove it stopped, then re-restore whatever
 * moved while we warmed up. Three steps, and their ORDER is the design:
 *
 *   1. Is anybody there? A live predecessor acknowledges us (ack.ts), and the
 *      ASG lists it (overlap.ts). Either is enough; the ASG covers a predecessor
 *      that does not speak this protocol — notably on the very roll that
 *      switches it on.
 *   2. Release the launch hook. It is what gets the predecessor its SIGTERM, so
 *      waiting for its report first would be waiting on ourselves.
 *   3. Somebody there: wait — long, and free, since it is still serving — until
 *      it reports, or the ASG says it is gone. Nobody: the short wait; every
 *      second of it is outage on a crash recovery, and proceeding at its end is
 *      what keeps a crash recovery from becoming a refusal to serve.
 */
export async function runHandoverGate(cfg: Config, deps: GateDeps): Promise<void> {
  const acked = await awaitAck(deps, {
    selfInstanceId: deps.instanceId,
    announceId: deps.announceId,
    deadlineMs: deps.announcedAtMs + cfg.handoverAckMs,
  });
  const peersAtStart = await deps.peers();
  await deps.completeLaunch();

  const someoneThere = acked !== null || (peersAtStart !== null && peersAtStart.length > 0);
  const outcome: StopOutcome = someoneThere
    ? await awaitPredecessorStop(deps, { baseline: deps.baseline, timeoutMs: cfg.handoverOverlapTimeoutMs, peers: deps.peers })
    : await awaitHandover(deps, { baseline: deps.baseline, timeoutMs: cfg.handoverTimeoutMs });

  if (outcome.reason === "timeout") {
    console.error(
      JSON.stringify({
        type: "handover",
        event: "proceeding-unproven",
        message: someoneThere
          ? "a LIVE predecessor neither reported its stop nor left the ASG before the deadline — starting replication anyway. Check for a dual writer."
          : "nobody answered and nobody is listed — starting replication. Expected on a crash recovery or a process restart.",
        acked,
        peers: peersAtStart,
      }),
    );
    return;
  }

  // Gone without a report, or a report that could not name what moved: never
  // "nothing moved". Re-restore everything we hold rather than guess.
  const unknown = outcome.reason === "predecessor-gone" || outcome.record.dirtyUnknown === true;
  const keys = unknown ? deps.servedKeys() : outcome.reason === "handover" ? outcome.record.dirtyApps : [];
  if (keys.length === 0) {
    log({ event: "catchup-empty", reason: outcome.reason });
    return;
  }
  log({ event: "catchup-start", apps: keys.length, unknown });
  const startedAt = Date.now();
  const done = await catchUp(deps.catchUpDeps, keys);
  log({ event: "catchup-done", requested: keys.length, restored: done.length, ms: Date.now() - startedAt });
}
