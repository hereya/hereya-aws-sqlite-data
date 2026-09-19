// Waiting for a LIVE predecessor to stop — with the ASG as a second witness
// (t_vm_zero_cut_handover).
//
// The ack (ack.ts) only exists if the predecessor runs this protocol. Two real
// cases where it does not, and where the replacement would otherwise take the
// short "nobody is there" wait and start replicating beside a live writer:
//
//   • THE ROLL THAT SWITCHES THE HANDOVER ON. The predecessor is the previous
//     service: no watcher, no ack, no report — and the ASG already overlaps.
//   • a predecessor whose watcher cannot reach DynamoDB.
//
// So the ASG itself is asked who else is in the group. It is ground truth in
// both directions: an instance listed there is not yet terminated, and one that
// has left the list is not writing anything. That second half also settles the
// case the design used to leave open — a HUNG predecessor. We no longer guess
// after a timeout; we proceed when the ASG says it is gone.
//
// A predecessor that is GONE WITHOUT A REPORT is handled as `dirtyUnknown`:
// it may have shipped writes to the replica after our restore, and it can no
// longer tell us which, so every app is re-restored. Deleting our copies is
// safe for the same reason the catch-up is: the only other writer is proven
// stopped, and we have not written. What it had not shipped is lost — exactly
// as in any crash, and no worse.
import { DescribeAutoScalingInstancesCommand } from "@aws-sdk/client-auto-scaling";
import type { LifecycleDeps } from "./lifecycle.ts";
import { POLL_INTERVAL_MS, type HandoverDeps, type HandoverOutcome } from "./protocol.ts";
import { getHandover, supersedes, type HandoverRecord } from "./record.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

/** How often the ASG is asked whether the predecessor is still there. */
export const PEER_POLL_MS = 2_000;

/**
 * The other instances of OUR Auto Scaling group, in any state short of
 * terminated. `null` = could not tell, which callers must read as "unknown",
 * never as "none".
 */
export async function listPeers(deps: LifecycleDeps, selfInstanceId: string): Promise<string[] | null> {
  if (!selfInstanceId) return null;
  try {
    const mine = await deps.client.send(new DescribeAutoScalingInstancesCommand({ InstanceIds: [selfInstanceId] }));
    const group = mine.AutoScalingInstances?.[0]?.AutoScalingGroupName;
    if (!group) return null;
    const peers: string[] = [];
    let NextToken: string | undefined;
    do {
      const page = await deps.client.send(new DescribeAutoScalingInstancesCommand({ NextToken }));
      for (const inst of page.AutoScalingInstances ?? []) {
        if (inst.AutoScalingGroupName !== group || !inst.InstanceId || inst.InstanceId === selfInstanceId) continue;
        if (inst.LifecycleState === "Terminated") continue;
        peers.push(inst.InstanceId);
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return peers;
  } catch (err) {
    console.error(JSON.stringify({ type: "handover", event: "peers-unreadable", message: (err as Error).message }));
    return null;
  }
}

export type StopOutcome = HandoverOutcome | { reason: "predecessor-gone" };

/**
 * Wait until the predecessor has provably stopped: it REPORTED it (the normal
 * case, seconds), or the ASG no longer lists it. `timeout` remains, for the
 * case where neither can be read.
 */
export async function awaitPredecessorStop(
  deps: HandoverDeps,
  opts: {
    baseline: HandoverRecord | null;
    timeoutMs: number;
    /** Returns the peers still in the group, or null when unknown. */
    peers: () => Promise<string[] | null>;
  },
): Promise<StopOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  let nextPeerCheck = startedAt;
  log({ event: "await-stop", timeoutMs: opts.timeoutMs, baselineSeq: opts.baseline?.seq ?? 0 });
  for (;;) {
    const record = await getHandover(deps);
    if (supersedes(opts.baseline, record)) {
      log({ event: "observed", from: record.fromInstanceId, seq: record.seq, waitedMs: now() - startedAt });
      return { reason: "handover", record };
    }
    if (now() >= nextPeerCheck) {
      nextPeerCheck = now() + PEER_POLL_MS;
      const peers = await opts.peers();
      if (peers !== null && peers.length === 0) {
        // Look once more: a report published in the instant between our read
        // and the ASG dropping the instance is worth far more than a full
        // re-restore.
        const last = await getHandover(deps);
        if (supersedes(opts.baseline, last)) return { reason: "handover", record: last };
        log({ event: "predecessor-gone", waitedMs: now() - startedAt });
        return { reason: "predecessor-gone" };
      }
    }
    if (now() - startedAt >= opts.timeoutMs) return { reason: "timeout" };
    await sleep(POLL_INTERVAL_MS);
  }
}
