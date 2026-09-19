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
import { catchUp, type CatchUpDeps } from "./catchup.ts";
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
  /** Every app this instance restored — the fallback list when the departing
   *  instance could not say which ones moved. */
  servedKeys: () => string[];
  catchUpDeps: CatchUpDeps;
}

/**
 * Wait for the previous instance to prove it stopped, then re-restore whatever
 * it says moved while we warmed up.
 *
 * ON TIMEOUT WE PROCEED, LOUDLY. That is deliberate and it is what makes the
 * flag safe to switch on BEFORE the ASG changes: with terminate-before-launch
 * the predecessor is already gone when we boot, so no report will ever arrive
 * and the wait always expires. Refusing to serve there would turn switching the
 * flag on into an outage. Once the ASG overlaps instances, the same timeout
 * means the genuinely dangerous case — a hung predecessor — and the operator
 * decides then whether to make it fatal; the log line is written so that
 * decision is made on evidence rather than in the dark.
 */
export async function runHandoverGate(cfg: Config, deps: GateDeps): Promise<void> {
  const outcome = await awaitHandover(deps, { baseline: deps.baseline, timeoutMs: cfg.handoverTimeoutMs });

  if (outcome.reason === "timeout") {
    console.error(
      JSON.stringify({
        type: "handover",
        event: "proceeding-unproven",
        message:
          "no predecessor proved it stopped — starting replication anyway. Expected while the ASG still terminates before launching; once it overlaps instances this means a HUNG predecessor.",
      }),
    );
    return;
  }

  // `dirtyUnknown` means the predecessor could not tell us which apps moved —
  // never that none did. Re-restore everything we hold rather than guess.
  const keys = outcome.record.dirtyUnknown ? deps.servedKeys() : outcome.record.dirtyApps;
  if (keys.length === 0) {
    log({ event: "catchup-empty", seq: outcome.record.seq });
    return;
  }
  log({ event: "catchup-start", apps: keys.length, unknown: outcome.record.dirtyUnknown === true });
  const done = await catchUp(deps.catchUpDeps, keys);
  log({ event: "catchup-done", requested: keys.length, restored: done.length });
}
