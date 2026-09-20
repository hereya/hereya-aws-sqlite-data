// Which CELL holds which app (t_dbmove_p2_placement).
//
// Until now "the VM" was a singleton and every instance restored, served and
// reconciled EVERY active app of EVERY org. That is the weld this file cuts,
// without changing anything production can observe: there is still one cell,
// and an app with no placement row belongs to it.
//
// A CELL is one serving VM plus its replacement slot — the unit that survives
// an instance roll. Placement is keyed by cell, never by instance id: an
// instance id changes at every deploy, and a placement that had to be rewritten
// for 100 apps on each roll would put a per-app loop back on the outage path.
//
// Rows live in a fixed partition of the registry table (the `_writestats` /
// `_handover` trick — org ids are UUIDs, so the literal cannot collide):
//
//   org_id = "_placement", sk = "<orgId>/<appId>"  →  { vmId, version, phase, targetVm }
//
// **No row = the origin cell.** That is what lets this ship with no migration:
// the partition is empty, so the origin cell owns everything, exactly as before.
import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { ServiceError } from "./errors.ts";
import type { AppRef, Registry, RegistryStatus } from "./registry.ts";

export const PLACEMENT_PARTITION = "_placement";
/** The cell that owns every app without a placement row. */
export const ORIGIN_CELL = "0";

const CELL_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function parseCellId(raw: string | undefined): string {
  if (raw === undefined || raw === "") return ORIGIN_CELL;
  if (!CELL_ID.test(raw)) throw new Error(`CELL_ID must match ${CELL_ID} (got "${raw}")`);
  return raw;
}

export function placementKey(orgId: string, appId: string): string {
  return `${orgId}/${appId}`;
}

/**
 * Every answer is fail-closed: an unreadable placement THROWS, it never says
 * "mine" and never says "not mine". Both wrong answers are dangerous — "mine"
 * starts a second litestream writer on another cell's database, "not mine"
 * makes the reconcile delete a local file this cell is the only holder of.
 */
export interface Placement {
  readonly cellId: string;
  isMine(orgId: string, appId: string): Promise<boolean>;
  filterMine(refs: AppRef[]): Promise<AppRef[]>;
  /** Drop the cache: the next answer is read from the store. */
  reload(): void;
}

/**
 * The whole partition is read at once and cached: it holds one row per MOVED
 * app (none today), so a strongly consistent Query is cheaper than a GetItem
 * per request, and a request never waits on DynamoDB while the cache is warm.
 * Errors are never cached.
 */
export class DdbPlacement implements Placement {
  readonly cellId: string;
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private owners: Map<string, string> | null = null;
  private loadedAt = 0;
  private loading: Promise<Map<string, string>> | null = null;

  constructor(opts: {
    cellId: string;
    tableName: string;
    region: string;
    cacheMs: number;
    client?: DynamoDBClient;
    now?: () => number;
  }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required for the ddb placement");
    this.cellId = opts.cellId;
    this.tableName = opts.tableName;
    this.cacheMs = opts.cacheMs;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
    this.now = opts.now ?? Date.now;
  }

  async isMine(orgId: string, appId: string): Promise<boolean> {
    const owners = await this.load();
    return this.owns(owners, placementKey(orgId, appId));
  }

  async filterMine(refs: AppRef[]): Promise<AppRef[]> {
    const owners = await this.load();
    return refs.filter((ref) => this.owns(owners, placementKey(ref.orgId, ref.appId)));
  }

  reload(): void {
    this.owners = null;
  }

  private owns(owners: Map<string, string>, key: string): boolean {
    return (owners.get(key) ?? ORIGIN_CELL) === this.cellId;
  }

  private load(): Promise<Map<string, string>> {
    if (this.owners && this.now() - this.loadedAt < this.cacheMs) return Promise.resolve(this.owners);
    // One read in flight, shared: a burst of requests on a cold cache must not
    // become a burst of Queries.
    this.loading ??= this.read().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async read(): Promise<Map<string, string>> {
    const owners = new Map<string, string>();
    let startKey: Record<string, AttributeValue> | undefined;
    try {
      do {
        const res = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "org_id = :p",
            ExpressionAttributeValues: { ":p": { S: PLACEMENT_PARTITION } },
            ProjectionExpression: "sk, vmId",
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of res.Items ?? []) {
          const sk = item.sk?.S;
          const vmId = item.vmId?.S;
          // A row without an owner is not "the origin": it is a row we cannot
          // read, and guessing is how a database gets two writers.
          if (!sk || !vmId) throw new Error(`placement row ${sk ?? "?"} has no vmId`);
          owners.set(sk, vmId);
        }
        startKey = res.LastEvaluatedKey;
      } while (startKey);
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `placement read failed: ${(err as Error).message}`);
    }
    this.owners = owners;
    this.loadedAt = this.now();
    return owners;
  }
}

/**
 * The registry as THIS cell sees it. `listActive` is what the boot restore and
 * the reconcile build the served set from — and the reconcile DELETES the local
 * file of any served app missing from that list. So the filter lives here,
 * below every caller: a third path cannot forget it.
 *
 * `lookup` is left alone on purpose. "Active" and "held here" are two facts,
 * and the request gate needs to tell them apart (403 vs 421).
 */
export class PlacedRegistry implements Registry {
  private readonly inner: Registry;
  private readonly placement: Placement;

  constructor(inner: Registry, placement: Placement) {
    this.inner = inner;
    this.placement = placement;
  }

  lookup(orgId: string, appId: string): Promise<RegistryStatus> {
    return this.inner.lookup(orgId, appId);
  }

  heldHere(orgId: string, appId: string): Promise<boolean> {
    return this.placement.isMine(orgId, appId);
  }

  async listActive(): Promise<AppRef[]> {
    return this.placement.filterMine(await this.inner.listActive());
  }

  async reload(): Promise<void> {
    this.placement.reload();
    await this.inner.reload();
  }
}
