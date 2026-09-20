// The two sides of the handover, and the one place its safety argument lives.
//
// THE SEQUENCE (t_vm_zero_cut_handover):
//
//   1. The replacement boots and restores every app from S3 — a READ. Two
//      instances reading the same replica do not disturb each other, so this
//      happens while the old one is still serving. It is also where the
//      measured 45 s goes (23 s machine + bootstrap, 21.5 s restore), which is
//      why this design removes the outage: the expensive part leaves the
//      critical path entirely.
//   2. The replacement ANNOUNCES it is warming, does NOT start litestream and
//      does NOT register in Cloud Map. It is warm and invisible.
//   3. The old one observes that announcement and dates it ON ITS OWN CLOCK —
//      that instant is the start of the window whose writes it must report.
//   4. The old one drains: stops serving, rolls back open transactions,
//      gives litestream its final sync window, and stops it —
//      `Litestream.stop()` waits for the child to EXIT. Only then does it publish the handover report.
//   5. The replacement sees the report, re-restores just the apps it names,
//      starts litestream, and registers.
//
// The visible cut is step 4's deregistration to step 5's registration —
// seconds — instead of a full boot.
//
// WHAT THIS IS NOT: a lease granting the right to write. A fencing token only
// protects when the resource validates it, and litestream → S3 validates
// nothing. The safety comes from ORDER, and from the stop being observed
// before it is announced.
//
// THE ONE UNCOVERED CASE, stated plainly: an old instance that is HUNG — not
// dead (a dead process writes nothing, which is the safe case), but alive with
// litestream still replicating and unable to publish. No report arrives and
// `awaitHandover` times out. What to do then is a policy decision with no
// risk-free answer, which is why it is returned as a distinct outcome rather
// than decided here.
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  getHandover,
  getWarming,
  putHandover,
  putWarming,
  supersedes,
  type HandoverRecord,
} from "./record.ts";

export interface HandoverDeps {
  client: DynamoDBClient;
  tableName: string;
  /** Whose roll this is (keys.ts). Absent = the origin cell. */
  cellId?: string;
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
 * Step 2, on the replacement: say that warming has begun, and take the
 * BASELINE the wait will be measured against.
 *
 * Returning the baseline from the same call is deliberate — it makes it
 * impossible to wait against a baseline read at some other moment, which is
 * the mistake the ordering rule exists to prevent.
 */
export async function announceWarming(
  deps: HandoverDeps,
  opts: { instanceId: string },
): Promise<HandoverRecord | null> {
  const now = deps.now ?? (() => Date.now());
  // ORDER IS LOAD-BEARING: read the baseline BEFORE announcing. Announcing
  // first opens a window in which the departing instance could observe us and
  // publish its report, which we would then read AS the baseline — and wait
  // for ever for a newer one that nobody will write. Reading first can only
  // fail the other way: a report published in between supersedes our baseline
  // and is accepted, and since that instance never saw our announcement it
  // reports `dirtyUnknown`, so the replacement re-restores everything. Slow,
  // never wrong.
  const baseline = await getHandover(deps);
  await putWarming(deps, { instanceId: opts.instanceId, atMs: now() });
  log({ event: "warming-announced", baselineSeq: baseline?.seq ?? 0 });
  return baseline;
}

/**
 * Step 3, on the DEPARTING instance: has a replacement announced itself, and
 * is it a different machine from us?
 *
 * Returns the instant of THIS observation, on the caller's own clock, or null
 * when there is nothing to observe yet. The caller keeps the FIRST non-null
 * answer: that is the start of the window, and taking a later one would drop
 * writes that landed before it.
 */
export async function observeWarming(
  deps: HandoverDeps,
  opts: { selfInstanceId: string },
): Promise<number | null> {
  const now = deps.now ?? (() => Date.now());
  const warming = await getWarming(deps);
  if (warming === null || warming.instanceId === opts.selfInstanceId) return null;
  return now();
}

/**
 * Step 5, on the replacement: wait for proof that the previous instance
 * stopped writing.
 *
 * `baseline` is what `announceWarming` returned. Ordering is by `seq`, so no
 * two machines' clocks are ever compared — see record.ts.
 *
 * Returns `timeout` rather than throwing, and rather than deciding: the caller
 * owns what an unproven stop means, because the two possible policies — refuse
 * to serve, or take over anyway — trade availability against the hung instance
 * above, and that trade belongs to the operator.
 */
export async function awaitHandover(
  deps: HandoverDeps,
  opts: { baseline: HandoverRecord | null; timeoutMs: number },
): Promise<HandoverOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  log({ event: "await-start", timeoutMs: opts.timeoutMs, baselineSeq: opts.baseline?.seq ?? 0 });

  for (;;) {
    const record = await getHandover(deps);
    if (supersedes(opts.baseline, record)) {
      log({
        event: "observed",
        from: record.fromInstanceId,
        seq: record.seq,
        dirtyApps: record.dirtyApps.length,
        dirtyUnknown: record.dirtyUnknown === true,
        waitedMs: now() - startedAt,
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
 * Step 4, on the departing instance: announce the stop. Called AFTER
 * litestream has exited — never before, or the report would assert something
 * untrue.
 *
 * `dirtyApps` comes from this process's own in-memory write counter, which is
 * the only place that knows it. A caller that could not establish the window
 * passes `null`, and the report says so: the replacement then re-restores
 * everything, which is slow but correct. Claiming "nothing changed" here would
 * be the one mistake in this file that silently serves stale customer data.
 *
 * `seq` is read-then-incremented rather than derived from a clock, so a
 * backwards clock jump on this machine cannot produce a report its successor
 * mistakes for an old one.
 *
 * The write is deliberately NOT conditional on `seq`. Read-then-write races
 * only if two instances publish at once, and only a DEPARTING instance ever
 * publishes: the ASG holds one, and during a handover the replacement has not
 * begun draining — it is the one waiting. A condition here would buy nothing
 * and would add a failure branch on the path of a process that is already
 * dying, which is the worst place to add one.
 */
export async function publishHandover(
  deps: HandoverDeps,
  opts: { instanceId: string; dirtyApps: string[] | null },
): Promise<boolean> {
  const now = deps.now ?? (() => Date.now());
  const previous = await getHandover(deps);
  const record: HandoverRecord = {
    seq: (previous?.seq ?? 0) + 1,
    fromInstanceId: opts.instanceId,
    atMs: now(),
    dirtyApps: opts.dirtyApps ?? [],
    dirtyUnknown: opts.dirtyApps === null,
  };
  const ok = await putHandover(deps, record);
  log({
    event: ok ? "published" : "publish-gave-up",
    seq: record.seq,
    dirtyApps: record.dirtyApps.length,
    dirtyUnknown: record.dirtyUnknown === true,
  });
  return ok;
}
