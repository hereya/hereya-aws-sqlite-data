// The move of ONE database, as written in its placement row (t_dbmove_p4_move).
//
//   _placement / <orgId>/<appId>  →  { vmId, version, phase, targetVm }
//
//   (no phase)  ──begin──▶  moving  ──▶  a_stopped  ──claim──▶  b_started  ──finalize──▶  (no phase, vmId = B)
//        ▲                     │             │
//        └──────cancel─────────┴─────────────┘
//
// THE SAFETY RULE IS THE CONDITIONS BELOW, not a convention of the callers:
// `cancel` and `claim` are conditional writes on the same row, so exactly one
// of them wins. Before `b_started` a move can only go back to A; from
// `b_started` on it can only finish on B — and no timer decides either. A timer
// may only decide to TRY; DynamoDB says who was first.
//
// `a_stopped` is a REPORT of a fact (A's litestream stop was observed), written
// by the one that observed it. `b_started` is a CLAIM: B writes it BEFORE it
// restores or registers anything, so a B that dies right after still owns the
// app, and its replacement restores it as its own (placement.ts reads
// `b_started` as "held by targetVm").
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { PLACEMENT_PARTITION, placementKey } from "../placement.ts";

export type MovePhase = "moving" | "a_stopped" | "b_started";

export interface MoveRow {
  key: string;
  vmId: string | null;
  version: number;
  phase: MovePhase | null;
  targetVm: string | null;
}

export interface MoveRecord {
  read(orgId: string, appId: string): Promise<MoveRow | null>;
  /** Null when the row is not `from`'s, or a move is already written on it. */
  begin(orgId: string, appId: string, from: string, to: string): Promise<number | null>;
  reportStopped(orgId: string, appId: string, version: number): Promise<boolean>;
  cancel(orgId: string, appId: string, version: number): Promise<boolean>;
  claim(orgId: string, appId: string, version: number, me: string): Promise<boolean>;
  finalize(orgId: string, appId: string, version: number, me: string): Promise<boolean>;
  /** Every row that carries a phase — what a sweep settles. */
  inFlight(): Promise<MoveRow[]>;
}

// Every attribute goes through a name placeholder: DynamoDB's reserved words
// have bitten this table before (`status`), and a collision is a runtime error.
const NAMES = { "#vm": "vmId", "#v": "version", "#ph": "phase", "#tv": "targetVm" };

function parse(item: Record<string, AttributeValue>): MoveRow {
  return {
    key: item.sk?.S ?? "",
    vmId: item.vmId?.S ?? null,
    version: Number(item.version?.N ?? 0),
    phase: (item.phase?.S as MovePhase | undefined) ?? null,
    targetVm: item.targetVm?.S ?? null,
  };
}

export class DdbMoveRecord implements MoveRecord {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts: { tableName: string; region: string; client?: DynamoDBClient }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required for database moves");
    this.tableName = opts.tableName;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
  }

  async read(orgId: string, appId: string): Promise<MoveRow | null> {
    const res = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: this.keyOf(orgId, appId), ConsistentRead: true }),
    );
    return res.Item ? parse(res.Item) : null;
  }

  async begin(orgId: string, appId: string, from: string, to: string): Promise<number | null> {
    // No row at all is legal (the app is where its org's row, or the origin,
    // says): the row is created naming `from`, which the caller has verified.
    const res = await this.update(orgId, appId, {
      update: "SET #vm = :from, #v = if_not_exists(#v, :zero) + :one, #ph = :moving, #tv = :to",
      condition: "(attribute_not_exists(#vm) OR #vm = :from) AND attribute_not_exists(#ph)",
      values: { ":from": { S: from }, ":to": { S: to }, ":moving": { S: "moving" }, ":zero": { N: "0" }, ":one": { N: "1" } },
    });
    return res === null ? null : Number(res.version?.N);
  }

  async reportStopped(orgId: string, appId: string, version: number): Promise<boolean> {
    return this.step(orgId, appId, version, "SET #ph = :next", "#ph = :moving", {
      ":next": { S: "a_stopped" },
      ":moving": { S: "moving" },
    });
  }

  async cancel(orgId: string, appId: string, version: number): Promise<boolean> {
    return this.step(orgId, appId, version, "REMOVE #ph, #tv", "#ph IN (:moving, :stopped)", {
      ":moving": { S: "moving" },
      ":stopped": { S: "a_stopped" },
    });
  }

  async claim(orgId: string, appId: string, version: number, me: string): Promise<boolean> {
    return this.step(orgId, appId, version, "SET #ph = :next", "#ph = :stopped AND #tv = :me", {
      ":next": { S: "b_started" },
      ":stopped": { S: "a_stopped" },
      ":me": { S: me },
    });
  }

  async finalize(orgId: string, appId: string, version: number, me: string): Promise<boolean> {
    return this.step(orgId, appId, version, "SET #vm = :me, #v = #v + :one REMOVE #ph, #tv", "#ph = :started AND #tv = :me", {
      ":started": { S: "b_started" },
      ":me": { S: me },
      ":one": { N: "1" },
    });
  }

  async inFlight(): Promise<MoveRow[]> {
    const rows: MoveRow[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "org_id = :p",
          FilterExpression: "attribute_exists(#ph)",
          ExpressionAttributeNames: { "#ph": "phase" },
          ExpressionAttributeValues: { ":p": { S: PLACEMENT_PARTITION } },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) rows.push(parse(item));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return rows;
  }

  private keyOf(orgId: string, appId: string): Record<string, AttributeValue> {
    return { org_id: { S: PLACEMENT_PARTITION }, sk: { S: placementKey(orgId, appId) } };
  }

  private async step(
    orgId: string,
    appId: string,
    version: number,
    update: string,
    condition: string,
    values: Record<string, AttributeValue>,
  ): Promise<boolean> {
    const res = await this.update(orgId, appId, {
      update,
      condition: `#v = :v AND ${condition}`,
      values: { ...values, ":v": { N: String(version) } },
    });
    return res !== null;
  }

  /** Null = the condition failed (someone else wrote first). Anything else throws. */
  private async update(
    orgId: string,
    appId: string,
    op: { update: string; condition: string; values: Record<string, AttributeValue> },
  ): Promise<Record<string, AttributeValue> | null> {
    const text = `${op.update} ${op.condition}`;
    const names = Object.fromEntries(Object.entries(NAMES).filter(([placeholder]) => new RegExp(`${placeholder}\\b`).test(text)));
    try {
      const res = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: this.keyOf(orgId, appId),
          UpdateExpression: op.update,
          ConditionExpression: op.condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: op.values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return res.Attributes ?? {};
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }
}
