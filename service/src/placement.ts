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
//
// An ORG row (sk = "<orgId>", no slash) places every app of that org that has
// no row of its own — how a NEW org lands on another cell while no VM may write
// here yet (t_dbmove_p3_relay_cells). ⚠️ Only for an org with no database yet:
// a row is a statement of where the file IS, it moves nothing.
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
  /** The cell that holds the app: its own row, else its org's, else the origin. */
  holderOf(orgId: string, appId: string): Promise<string>;
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
  private owners: Map<string, string | null> | null = null;
  private loadedAt = 0;
  private loading: Promise<Map<string, string | null>> | null = null;

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

  async holderOf(orgId: string, appId: string): Promise<string> {
    const holder = this.holder(await this.load(), orgId, appId);
    if (holder === null) {
      throw new ServiceError("UNAVAILABLE", `placement row for ${placementKey(orgId, appId)} has no vmId`);
    }
    return holder;
  }

  async isMine(orgId: string, appId: string): Promise<boolean> {
    return (await this.holderOf(orgId, appId)) === this.cellId;
  }

  async filterMine(refs: AppRef[]): Promise<AppRef[]> {
    const owners = await this.load();
    return refs.filter((ref) => this.holder(owners, ref.orgId, ref.appId) === this.cellId);
  }

  reload(): void {
    this.owners = null;
  }

  private holder(owners: Map<string, string | null>, orgId: string, appId: string): string | null {
    // `has`, not `??`: an ownerless row is stored as null, and null must not
    // fall through to the org's row or to the origin.
    for (const key of [placementKey(orgId, appId), orgId]) {
      if (owners.has(key)) return owners.get(key) ?? null;
    }
    return ORIGIN_CELL;
  }

  private load(): Promise<Map<string, string | null>> {
    if (this.owners && this.now() - this.loadedAt < this.cacheMs) return Promise.resolve(this.owners);
    // One read in flight, shared: a burst of requests on a cold cache must not
    // become a burst of Queries.
    this.loading ??= this.read().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async read(): Promise<Map<string, string | null>> {
    const owners = new Map<string, string | null>();
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
          if (!sk) continue;
          // A row without an owner is not "the origin": guessing is how a
          // database gets two writers. But it is ONE app's problem — that app
          // answers 503 and is held by nobody (its replica stays in S3), while
          // the rest of the cell keeps serving. Failing the whole read would
          // let one malformed row abort the boot of every org's databases.
          if (!vmId) console.error(JSON.stringify({ type: "placement", event: "row-without-owner", key: sk }));
          owners.set(sk, vmId ?? null);
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

  holderOf(orgId: string, appId: string): Promise<string> {
    return this.placement.holderOf(orgId, appId);
  }

  /** Placement only — what a relay re-reads on a peer's 421, without paying a registry Scan. */
  reloadPlacement(): void {
    this.placement.reload();
  }

  async listActive(): Promise<AppRef[]> {
    return this.placement.filterMine(await this.inner.listActive());
  }

  async reload(): Promise<void> {
    this.placement.reload();
    await this.inner.reload();
  }
}
