// The acknowledgement: how the replacement learns that a predecessor is ALIVE
// (t_vm_zero_cut_handover, the overlap piece).
//
// Until the ASG overlapped instances the replacement never needed to know: the
// predecessor was always already gone, so a short wait that always expired was
// merely a cost. With launch-before-terminate the same expiry means two
// opposite things —
//
//   • nobody was there (a crash recovery): waiting longer only extends an
//     outage that is already running;
//   • somebody IS there and has not stopped yet: starting replication now is
//     the dual writer, and the right move is to keep waiting — for free, since
//     the predecessor is still serving.
//
// A timeout cannot tell those apart, so the predecessor says which it is. When
// its watcher first sees the warming announcement it writes this record, naming
// the replacement it saw. The replacement accepts only an ack addressed to
// ITSELF: the item is reused by every roll, so an ack left by a previous one
// names another instance and reads as "no ack".
//
// ⚠️ …and addressed to THIS BOOT (t_handover_stale_ack_wipe). The item outlives
// the roll that wrote it, and the instance it names is the one that goes on
// serving. When that instance's PROCESS restarted — a crash, an OOM, a
// `systemctl restart` — it found the ack of its own first boot, took its dead
// predecessor for a live one, saw the ASG list nobody, concluded "gone without
// a report", and re-restored EVERYTHING it held: every local database deleted
// under live traffic (a crash never leaves Cloud Map), acknowledged writes
// with them. So an ack also echoes the `atMs` of the announcement it answers
// — a value only the announcing boot knows, compared for EQUALITY, never as a
// time. An ack from a predecessor that predates this (the roll that ships it)
// carries none and reads as "no ack": the ASG listing covers that roll, as it
// covered the roll that first switched the protocol on.
//
// Cloud Map was considered as the liveness signal and rejected: a hard crash
// leaves its registration behind (`register()` clears stale entries for that
// reason), so it would read "alive" precisely on the crash path.
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { cellKey } from "./keys.ts";
import type { HandoverDeps } from "./protocol.ts";
import { getWarming, HANDOVER_PARTITION } from "./record.ts";

export const ACK_KEY = "ack";
/** How often the replacement looks for the ack. */
export const ACK_POLL_MS = 500;

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

/**
 * On the PREDECESSOR: acknowledge whichever replacement is announcing itself.
 * Returns the instance acknowledged, or null when there was none or the write
 * failed. Never throws — the watcher that calls it must not die of it.
 */
export async function acknowledgeWarming(
  deps: HandoverDeps,
  opts: { selfInstanceId: string; alreadyAcked?: string | null },
): Promise<string | null> {
  const warming = await getWarming(deps);
  if (warming === null || warming.instanceId === opts.selfInstanceId) return null;
  const token = `${warming.instanceId}@${warming.atMs}`;
  if (token === opts.alreadyAcked) return token;
  try {
    await deps.client.send(
      new PutItemCommand({
        TableName: deps.tableName,
        Item: {
          org_id: { S: HANDOVER_PARTITION },
          sk: { S: cellKey(ACK_KEY, deps.cellId) },
          fromInstanceId: { S: opts.selfInstanceId },
          forInstanceId: { S: warming.instanceId },
          forAtMs: { N: String(warming.atMs) },
        },
      }),
    );
    return token;
  } catch (err) {
    console.error(JSON.stringify({ type: "handover", event: "ack-failed", message: (err as Error).message }));
    return null;
  }
}

async function readAckFor(deps: HandoverDeps, selfInstanceId: string, announceId: number): Promise<string | null> {
  try {
    const res = await deps.client.send(
      new GetItemCommand({
        TableName: deps.tableName,
        Key: { org_id: { S: HANDOVER_PARTITION }, sk: { S: cellKey(ACK_KEY, deps.cellId) } },
        ConsistentRead: true,
      }),
    );
    const item = res.Item as Record<string, { S?: string; N?: string }> | undefined;
    if (item?.forInstanceId?.S !== selfInstanceId) return null;
    // Ours, but for which boot? See the header: a previous life's ack is not proof of life.
    if (item.forAtMs?.N === undefined || Number(item.forAtMs.N) !== announceId) return null;
    return item.fromInstanceId?.S ?? null;
  } catch {
    // Unreadable = no proof of life. The caller then takes the short wait,
    // which is the pre-overlap behaviour.
    return null;
  }
}

/**
 * On the REPLACEMENT: is a predecessor alive and aware of us?
 *
 * `deadlineMs` is an instant on THIS machine's clock, counted from our own
 * announcement — so on a real fleet the ~21 s restore has already absorbed it
 * and this returns at once either way. Returns the predecessor's instance id,
 * or null when nobody answered in time.
 */
export async function awaitAck(
  deps: HandoverDeps,
  opts: { selfInstanceId: string; announceId: number; deadlineMs: number },
): Promise<string | null> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const from = await readAckFor(deps, opts.selfInstanceId, opts.announceId);
    if (from !== null) {
      log({ event: "predecessor-alive", from });
      return from;
    }
    if (now() >= opts.deadlineMs) {
      log({ event: "no-predecessor" });
      return null;
    }
    await sleep(ACK_POLL_MS);
  }
}
