// The handover records: how a departing instance tells its replacement that it
// has STOPPED writing, and how the replacement tells it that it is warming up
// (t_vm_zero_cut_handover).
//
// Why records and not a lease. A fencing token only protects if the RESOURCE
// checks it on every write, and the resource here is `litestream replicate` →
// S3: an external process that presents no token and cannot be made to. So the
// handover record is deliberately NOT "permission to write" — it is a REPORT of
// a fact that has already happened, published only after `Litestream.stop()`
// has returned, which itself waits for the child process to exit (SIGTERM,
// SIGKILL at 5 s). The two writers are separated by an observed stop rather
// than by a belief about who holds a key.
//
// ⚠️ NOTHING HERE COMPARES TWO MACHINES' CLOCKS. That was the first version's
// flaw: the replacement tested `record.atMs > myWarmStart`, i.e. the departing
// instance's wall clock against its own. Amazon Time Sync makes that work
// almost always, which is exactly what makes it a bad dependency — it would
// fail rarely and inexplicably, and in the dangerous direction: a clock running
// ahead on the old instance makes a record from a PREVIOUS roll read as fresh,
// which is the one thing the check exists to prevent. Ordering now comes from
// `seq`, a counter whose values are only ever compared with each other.
import {
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

/** The fixed partition. Org ids are UUIDs, so this literal cannot collide. */
export const HANDOVER_PARTITION = "_handover";
/** The departing instance's report. One at a time: the latest replaces it. */
export const HANDOVER_KEY = "current";
/** The replacement's "I am warming up" announcement. */
export const WARMING_KEY = "warming";

export interface HandoverRecord {
  /**
   * Monotonic generation, incremented by each departing instance from the
   * value it reads. It is the ONLY ordering signal: comparing successive values
   * of one counter is sound, comparing two machines' clocks is not.
   */
  seq: number;
  /** The instance that stopped. For logs, and to make a record self-describing. */
  fromInstanceId: string;
  /** When the stop was observed, on the DEPARTING instance's own clock. Never
   *  compared against another machine's clock — humans read it, code does not. */
  atMs: number;
  /**
   * The apps whose database CHANGED while the replacement was warming up, as
   * `<orgId>/<appId>` keys.
   *
   * This is what keeps the handover cheap. The replacement restores every app
   * from S3 while the old instance is still serving, so its copy of anything
   * written during that window is stale — and litestream cannot "catch up" a
   * file that already exists (restoring over it is the stale-data trap
   * invariant 2 forbids). Re-restoring EVERYTHING would cost the 21.5 s the
   * handover exists to remove. The departing instance knows the answer:
   * `WriteStats` holds `lastWriteMs` per app, in memory, on the very process
   * that served those writes. Measured fleet: 61 apps, 2 ever seen writing.
   */
  dirtyApps: string[];
  /** True when the departing instance could not establish the window (it never
   *  saw the warming announcement) and the replacement must therefore
   *  re-restore everything rather than trust a list built from nothing. */
  dirtyUnknown?: boolean;
}

export interface WarmingRecord {
  instanceId: string;
  /** On the REPLACEMENT's clock — only ever used to tell two announcements
   *  apart, never compared against the departing instance's clock. */
  atMs: number;
}

type Item = Record<string, { S?: string; N?: string; L?: unknown[]; BOOL?: boolean }> | undefined;

function parseHandover(item: Item): HandoverRecord | null {
  if (!item) return null;
  const seq = Number(item.seq?.N ?? "");
  if (!Number.isFinite(seq) || seq <= 0) return null;
  const list = Array.isArray(item.dirtyApps?.L) ? item.dirtyApps.L : [];
  return {
    seq,
    fromInstanceId: item.fromInstanceId?.S ?? "",
    atMs: Number(item.atMs?.N ?? "0"),
    dirtyApps: list
      .map((e) => (e as { S?: string }).S)
      .filter((s): s is string => typeof s === "string" && s.length > 0),
    dirtyUnknown: item.dirtyUnknown?.BOOL === true,
  };
}

/** Never throws: a departing instance that cannot publish must still die
 *  cleanly — the replacement then falls back to its timeout, which is the
 *  conservative path (see awaitHandover). */
export async function putHandover(
  deps: { client: DynamoDBClient; tableName: string },
  record: HandoverRecord,
): Promise<boolean> {
  try {
    await deps.client.send(
      new PutItemCommand({
        TableName: deps.tableName,
        Item: {
          org_id: { S: HANDOVER_PARTITION },
          sk: { S: HANDOVER_KEY },
          seq: { N: String(record.seq) },
          fromInstanceId: { S: record.fromInstanceId },
          atMs: { N: String(record.atMs) },
          dirtyApps: { L: record.dirtyApps.map((key) => ({ S: key })) },
          dirtyUnknown: { BOOL: record.dirtyUnknown === true },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error(JSON.stringify({ type: "handover", event: "publish-failed", message: (err as Error).message }));
    return false;
  }
}

/**
 * Read the report, or null when there is none / it cannot be read.
 *
 * A read FAILURE and "no record" are deliberately the same answer: both mean
 * "no proof that anyone stopped", and every caller must treat the absence of
 * proof as a reason to wait, never as permission to start.
 */
export async function getHandover(
  deps: { client: DynamoDBClient; tableName: string },
): Promise<HandoverRecord | null> {
  try {
    const res = await deps.client.send(
      new GetItemCommand({
        TableName: deps.tableName,
        Key: { org_id: { S: HANDOVER_PARTITION }, sk: { S: HANDOVER_KEY } },
        // Eventually-consistent here would let the replacement miss the very
        // record it is waiting for and time out on a handover that happened.
        ConsistentRead: true,
      }),
    );
    return parseHandover(res.Item as Item);
  } catch (err) {
    console.error(JSON.stringify({ type: "handover", event: "read-failed", message: (err as Error).message }));
    return null;
  }
}

/** The replacement says it has begun warming, so the departing instance can
 *  date the window whose writes it must report. Best-effort by design. */
export async function putWarming(
  deps: { client: DynamoDBClient; tableName: string },
  record: WarmingRecord,
): Promise<boolean> {
  try {
    await deps.client.send(
      new PutItemCommand({
        TableName: deps.tableName,
        Item: {
          org_id: { S: HANDOVER_PARTITION },
          sk: { S: WARMING_KEY },
          instanceId: { S: record.instanceId },
          atMs: { N: String(record.atMs) },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error(JSON.stringify({ type: "handover", event: "warming-failed", message: (err as Error).message }));
    return false;
  }
}

export async function getWarming(
  deps: { client: DynamoDBClient; tableName: string },
): Promise<WarmingRecord | null> {
  try {
    const res = await deps.client.send(
      new GetItemCommand({
        TableName: deps.tableName,
        Key: { org_id: { S: HANDOVER_PARTITION }, sk: { S: WARMING_KEY } },
        ConsistentRead: true,
      }),
    );
    const item = res.Item as Item;
    if (!item?.instanceId?.S) return null;
    return { instanceId: item.instanceId.S, atMs: Number(item.atMs?.N ?? "0") };
  } catch {
    return null;
  }
}

/**
 * Has the report moved on from the baseline the replacement saw at warm start?
 *
 * `baseline` is the record as it stood when THIS instance began warming — null
 * when there was none. The comparison is between two readings of one counter,
 * so it holds whatever either machine's clock says. That is the whole point:
 * the record is a single durable item reused by every roll, so without an
 * ordering signal the first read would always succeed, on a stop that happened
 * days ago.
 */
export function supersedes(baseline: HandoverRecord | null, current: HandoverRecord | null): current is HandoverRecord {
  if (current === null) return false;
  return baseline === null || current.seq > baseline.seq;
}
