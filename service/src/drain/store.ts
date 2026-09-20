// A cell being EMPTIED, as written in the table (t_dbmove_p5_drain_ops).
//
//   _vms / "drain#<cellId>"       →  the ORDER     — written by the admin route
//   _vms / "drainstate#<cellId>"  →  the PROGRESS  — written by the draining cell
//
// Two rows because the partition's only grants are whole-row PutItem and
// DeleteItem (instance-role.ts): with ONE writer per row nobody overwrites what
// somebody else just said — an operator's "stop" cannot be undone by a progress
// report that was already on its way. No new IAM: both live in `_vms`, and
// vms.ts ignores them (no "/" in the key, no address).
//
// An order is an INTENT, never a fact about where a database is. It moves
// nothing by itself: the draining cell reads it and asks its own mover, app by
// app, and every safety rule stays where it was (move/record.ts).
import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { VMS_PARTITION } from "../vms.ts";

export interface DrainOrder {
  cellId: string;
  toCell: string;
  /** A database above MOVE_MAX_BYTES: leave it where it is, or move it anyway (long pause). */
  big: "skip" | "force";
  /** Leave Cloud Map once the cell holds nothing — what makes its roll invisible. */
  leave: boolean;
  orderedAtMs: number;
}

export interface DrainProgress {
  cellId: string;
  toCell: string;
  instanceId: string;
  /** `empty` = holds nothing · `blocked` = the last pass gave up (see lastError). */
  state: "draining" | "empty" | "blocked";
  inCloudMap: boolean;
  /**
   * Ms since this instance last received a request THROUGH THE GATEWAY (null =
   * never). Leaving Cloud Map is not leaving the gateway: it keeps its targets
   * for a while (measured on the trial stack: requests still arrived ~25 s
   * later, and replacing the instance then showed clients its 503s). An emptied
   * cell is safe to replace once this has grown past a couple of minutes — read
   * on this machine's clock alone.
   */
  gatewayQuietMs: number | null;
  held: number;
  moved: number;
  failed: number;
  skippedBig: string[];
  passes: number;
  lastError: string | null;
  atMs: number;
}

export interface DrainStore {
  readOrder(cellId: string): Promise<DrainOrder | null>;
  putOrder(order: DrainOrder): Promise<void>;
  deleteOrder(cellId: string): Promise<void>;
  readProgress(cellId: string): Promise<DrainProgress | null>;
  putProgress(progress: DrainProgress): Promise<void>;
}

const orderKey = (cellId: string): string => `drain#${cellId}`;
const progressKey = (cellId: string): string => `drainstate#${cellId}`;

export class DdbDrainStore implements DrainStore {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts: { tableName: string; region: string; client?: DynamoDBClient }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required for cell drains");
    this.tableName = opts.tableName;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
  }

  readOrder(cellId: string): Promise<DrainOrder | null> {
    return this.read<DrainOrder>(orderKey(cellId));
  }

  putOrder(order: DrainOrder): Promise<void> {
    return this.put(orderKey(order.cellId), order);
  }

  async deleteOrder(cellId: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: this.keyOf(orderKey(cellId)) }));
  }

  readProgress(cellId: string): Promise<DrainProgress | null> {
    return this.read<DrainProgress>(progressKey(cellId));
  }

  putProgress(progress: DrainProgress): Promise<void> {
    return this.put(progressKey(progress.cellId), progress);
  }

  private keyOf(sk: string): Record<string, AttributeValue> {
    return { org_id: { S: VMS_PARTITION }, sk: { S: sk } };
  }

  // One JSON attribute: the rows have a single reader and a single writer, and
  // this table's reserved words (`state`, `status`) have bitten before.
  private async read<T>(sk: string): Promise<T | null> {
    const res = await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: this.keyOf(sk), ConsistentRead: true }));
    const doc = res.Item?.doc?.S;
    return doc === undefined ? null : (JSON.parse(doc) as T);
  }

  private async put(sk: string, doc: unknown): Promise<void> {
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: { ...this.keyOf(sk), doc: { S: JSON.stringify(doc) } } }));
  }
}
