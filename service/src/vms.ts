// Which INSTANCE answers for which cell, on the private network
// (t_dbmove_p3_relay_cells).
//
// Placement says "cell 1 holds this app"; a relay needs an address. Every
// instance writes its own row when it starts serving, keeps a counter moving
// while it lives, and marks the row retired when it drains:
//
//   org_id = "_vms", sk = "<cellId>/<instanceId>"
//     →  { ip, port, state: serving|retired|evicted, beat, atMs }
//
// Keyed by cell AND instance: during a hot handover a cell has two instances
// for a few seconds, and both rows are true.
//
// ⚠️ `atMs` is never compared with another machine's clock to decide anything
// that matters (the handover's rule). Liveness is judged from `beat`, a counter
// a watcher only ever compares with the value IT read last time, on ITS clock
// (peer-watch.ts). `atMs` merely orders the candidates of one cell, and a wrong
// order costs one failed connection, not a wrong answer.
import { DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { ServiceError } from "./errors.ts";

export const VMS_PARTITION = "_vms";

export type VmState = "serving" | "retired" | "evicted";

export interface VmRow {
  cellId: string;
  instanceId: string;
  ip: string;
  port: number;
  state: VmState;
  beat: number;
  atMs: number;
}

export interface VmIdentity {
  cellId: string;
  instanceId: string;
  ip: string;
  port: number;
}

/** What a relay needs: where a cell answers. */
export interface PeerLookup {
  /** The serving instances of a cell, most recently announced first. */
  targets(cellId: string): Promise<VmRow[]>;
  /** Every serving instance OUTSIDE a cell, read now — for a broadcast. */
  others(cellId: string): Promise<VmRow[]>;
  reload(): void;
}

function parseRow(item: Record<string, AttributeValue>): VmRow | null {
  const [cellId, instanceId] = (item.sk?.S ?? "").split("/");
  const ip = item.ip?.S;
  const port = Number(item.port?.N);
  const state = item.state?.S as VmState | undefined;
  if (!cellId || !instanceId || !ip || !Number.isInteger(port) || !state) return null;
  return { cellId, instanceId, ip, port, state, beat: Number(item.beat?.N ?? 0), atMs: Number(item.atMs?.N ?? 0) };
}

export class VmDirectory implements PeerLookup {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private rows: VmRow[] | null = null;
  private loadedAt = 0;
  private loading: Promise<VmRow[]> | null = null;

  constructor(opts: { tableName: string; region: string; cacheMs: number; client?: DynamoDBClient; now?: () => number }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required for the vm directory");
    this.tableName = opts.tableName;
    this.cacheMs = opts.cacheMs;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
    this.now = opts.now ?? Date.now;
  }

  async targets(cellId: string): Promise<VmRow[]> {
    const rows = await this.load();
    return rows.filter((r) => r.cellId === cellId && r.state === "serving").sort((a, b) => b.atMs - a.atMs);
  }

  async others(cellId: string): Promise<VmRow[]> {
    return (await this.readAll()).filter((r) => r.cellId !== cellId && r.state === "serving");
  }

  reload(): void {
    this.rows = null;
  }

  /** Every row, read NOW — the watcher must never judge a cached counter. */
  readAll(): Promise<VmRow[]> {
    this.rows = null;
    return this.load();
  }

  /** Whole-row write: PutItem is the only grant this partition has. */
  async put(self: VmIdentity, state: VmState, beat: number): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          org_id: { S: VMS_PARTITION },
          sk: { S: `${self.cellId}/${self.instanceId}` },
          ip: { S: self.ip },
          port: { N: String(self.port) },
          state: { S: state },
          beat: { N: String(beat) },
          atMs: { N: String(this.now()) },
        },
      }),
    );
    this.rows = null;
  }

  async remove(row: Pick<VmRow, "cellId" | "instanceId">): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { org_id: { S: VMS_PARTITION }, sk: { S: `${row.cellId}/${row.instanceId}` } },
      }),
    );
    this.rows = null;
  }

  private load(): Promise<VmRow[]> {
    if (this.rows && this.now() - this.loadedAt < this.cacheMs) return Promise.resolve(this.rows);
    this.loading ??= this.read().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async read(): Promise<VmRow[]> {
    const rows: VmRow[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    try {
      do {
        const res = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "org_id = :p",
            ExpressionAttributeValues: { ":p": { S: VMS_PARTITION } },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of res.Items ?? []) {
          const row = parseRow(item);
          if (row) rows.push(row);
        }
        startKey = res.LastEvaluatedKey;
      } while (startKey);
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `vm directory read failed: ${(err as Error).message}`);
    }
    this.rows = rows;
    this.loadedAt = this.now();
    return rows;
  }
}
