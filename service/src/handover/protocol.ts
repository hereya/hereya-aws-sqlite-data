// The two halves of the handover, and the one place its safety argument lives.
//
// THE SEQUENCE (t_vm_zero_cut_handover):
//
//   1. The replacement boots and restores every app from S3 — a READ. Two
//      instances reading the same replica do not disturb each other, so this
//      can happen while the old one is still serving. It is also where the
//      measured 45 s goes (23 s machine + bootstrap, 21.5 s restore), which is
//      the whole reason this design removes the outage: the expensive part
//      leaves the critical path entirely.
//   2. The replacement does NOT start litestream and does NOT register in
//      Cloud Map. It is warm and invisible.
//   3. The old one drains: stops serving, rolls back open transactions,
//      checkpoints, and stops litestream — `Litestream.stop()` waits for the
//      child to EXIT. Only then does it publish the handover record.
//   4. The replacement sees that record, re-restores just the apps written
//      during the window, starts litestream, and registers.
//
// The visible cut is therefore step 3's deregistration to step 4's
// registration — seconds — instead of a full boot.
//
// WHAT THIS IS NOT: a lease granting the right to write. A fencing token only
// protects when the resource validates it, and litestream → S3 validates
// nothing. The safety here comes from ORDER, and from the fact that the stop is
// observed before it is announced.
//
// THE ONE UNCOVERED CASE, stated plainly: an old instance that is HUNG — not
// dead (a dead process writes nothing, which is the safe case), but alive with
// litestream still replicating and unable to publish. No record arrives, and
// `awaitHandover` eventually times out. What the caller does then is a policy
// decision with no risk-free answer, which is why it is returned as a distinct
// outcome rather than decided here.
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getHandover, isFresh, putHandover, type HandoverRecord } from "./record.ts";

export interface HandoverDeps {
  client: DynamoDBClient;
  tableName: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

/** How often the replacement asks whether the old one has stopped. */
export const POLL_INTERVAL_MS = 500;

export type HandoverOutcome =
  | { reason: "handover"; record: HandoverRecord }
  | { reason: "timeout" };

/**
 * Wait for proof that the previous instance stopped writing.
 *
 * `warmStartedAt` must be the instant THIS instance began warming up: any
 * record at or before it describes an older roll (see `isFresh`).
 *
 * Returns `timeout` rather than throwing, and rather than deciding: the caller
 * owns what an unproven stop means, because the two possible policies —
 * refuse to serve, or take over anyway — trade availability against the hung
 * instance above, and that trade belongs to the operator.
 */
export async function awaitHandover(
  deps: HandoverDeps,
  opts: { warmStartedAt: number; timeoutMs: number },
): Promise<HandoverOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  log({ event: "await-start", timeoutMs: opts.timeoutMs });

  for (;;) {
    const record = await getHandover(deps);
    if (isFresh(record, opts.warmStartedAt)) {
      log({
        event: "observed",
        from: record.fromInstanceId,
        dirtyApps: record.dirtyApps.length,
        dirtyUnknown: record.dirtyUnknown === true,
        waitedMs: now() - opts.warmStartedAt,
      });
      return { reason: "handover", record };
    }
    if (now() >= deadline) {
      // Loud on purpose: this is the branch where the design's one uncovered
      // case would show up, and it must never pass as routine.
      console.error(
        JSON.stringify({
          type: "handover",
          event: "timeout",
          message: "no handover was published before the deadline — the previous instance never proved it stopped",
          timeoutMs: opts.timeoutMs,
        }),
      );
      return { reason: "timeout" };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Announce the stop. Called by the departing instance AFTER litestream has
 * exited — never before, or the record would assert something untrue.
 *
 * `dirtyApps` comes from the departing process's own in-memory write counter,
 * which is the only place that knows it. A caller that cannot produce the list
 * passes `null`, and the record says so: the replacement then re-restores
 * everything, which is slow but correct. Guessing "nothing changed" here would
 * be the one mistake in this file that silently serves stale customer data.
 */
export async function publishHandover(
  deps: HandoverDeps,
  opts: { instanceId: string; dirtyApps: string[] | null },
): Promise<boolean> {
  const now = deps.now ?? (() => Date.now());
  const record: HandoverRecord = {
    fromInstanceId: opts.instanceId,
    atMs: now(),
    dirtyApps: opts.dirtyApps ?? [],
    dirtyUnknown: opts.dirtyApps === null,
  };
  const ok = await putHandover(deps, record);
  log({
    event: ok ? "published" : "publish-gave-up",
    dirtyApps: record.dirtyApps.length,
    dirtyUnknown: record.dirtyUnknown === true,
  });
  return ok;
}
