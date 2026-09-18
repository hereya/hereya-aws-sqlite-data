// The handover record: how a departing instance tells its replacement that it
// has STOPPED writing, and which databases moved while the replacement warmed
// up (t_vm_zero_cut_handover).
//
// Why a record and not a lease. A fencing token only protects if the RESOURCE
// checks it on every write, and the resource here is `litestream replicate` →
// S3: an external process that presents no token and cannot be made to. So this
// is deliberately NOT "permission to write" — it is a REPORT of a fact that has
// already happened, published only after `Litestream.stop()` has returned,
// which itself waits for the child process to exit (SIGTERM, SIGKILL at 5 s).
// The two writers are therefore separated by an observed stop rather than by a
// belief about who holds a key.
//
// It lives in the registry table's own fixed partition, the `_writestats` /
// `_hosts` / `_catalog` trick: org ids are UUIDs, so the literal cannot collide
// with a real org, and the instance role's grant stays pinned to it by
// `dynamodb:LeadingKeys`.
import {
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

/** The fixed partition. Org ids are UUIDs, so this literal cannot collide. */
export const HANDOVER_PARTITION = "_handover";
/** One record at a time: the latest handover replaces the previous one. */
export const HANDOVER_KEY = "current";

export interface HandoverRecord {
  /** The instance that stopped. Only ever used to make logs readable. */
  fromInstanceId: string;
  /** When the stop was OBSERVED — after litestream exited, never before. */
  atMs: number;
  /**
   * The apps whose database CHANGED while the replacement was warming up, as
   * `<orgId>/<appId>` keys.
   *
   * This is the field that makes the whole design work. The replacement
   * restores every app from S3 while the old instance is still serving, so its
   * copy of anything written during that window is stale — and litestream
   * cannot "catch up" a file that already exists (restoring over it is the
   * stale-data trap invariant 2 forbids). Re-restoring EVERYTHING would cost
   * the 21.5 s the handover exists to remove.
   *
   * The departing instance already knows the answer: `WriteStats` holds
   * `lastWriteMs` per app, in memory, on the very process that served those
   * writes. On the measured fleet this list is nearly always empty — 2 apps of
   * 61 had ever been seen writing — so the catch-up is ~0 s in the common case
   * and bounded by real activity in the worst one.
   */
  dirtyApps: string[];
  /** True when the departing instance could not enumerate its writes and the
   *  replacement must therefore re-restore everything rather than guess. */
  dirtyUnknown?: boolean;
}

function parse(item: Record<string, { S?: string; N?: string; L?: unknown[]; BOOL?: boolean }> | undefined): HandoverRecord | null {
  if (!item) return null;
  const atMs = Number(item.atMs?.N ?? "");
  if (!Number.isFinite(atMs) || atMs <= 0) return null;
  const list = Array.isArray(item.dirtyApps?.L) ? item.dirtyApps.L : [];
  const dirtyApps = list
    .map((entry) => (entry as { S?: string }).S)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return {
    fromInstanceId: item.fromInstanceId?.S ?? "",
    atMs,
    dirtyApps,
    dirtyUnknown: item.dirtyUnknown?.BOOL === true,
  };
}

/**
 * Publish the stop. Never throws: a departing instance that cannot write this
 * record must still finish dying cleanly — the replacement then falls back to
 * its timeout, which is the conservative path (see awaitHandover).
 */
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
          fromInstanceId: { S: record.fromInstanceId },
          atMs: { N: String(record.atMs) },
          dirtyApps: { L: record.dirtyApps.map((key) => ({ S: key })) },
          dirtyUnknown: { BOOL: record.dirtyUnknown === true },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({ type: "handover", event: "publish-failed", message: (err as Error).message }),
    );
    return false;
  }
}

/**
 * Read the record, or null when there is none / it cannot be read.
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
        ConsistentRead: true,
      }),
    );
    return parse(res.Item as never);
  } catch (err) {
    console.error(
      JSON.stringify({ type: "handover", event: "read-failed", message: (err as Error).message }),
    );
    return null;
  }
}

/**
 * Is this record the one we are waiting for?
 *
 * `after` is the instant the REPLACEMENT began warming up. A record older than
 * that belongs to a PREVIOUS roll — the record is a single item that survives
 * every handover, so without this check the first read would always succeed
 * instantly, on a stop that happened days ago, and the replacement would start
 * writing while the current instance still was. This one comparison is what
 * makes a durable single-item record safe to reuse.
 */
export function isFresh(record: HandoverRecord | null, after: number): record is HandoverRecord {
  return record !== null && record.atMs > after;
}
