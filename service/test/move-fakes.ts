// An in-memory MoveRecord with the SAME conditions as record.ts, shared by the
// cells of a test — so "cancel and claim: exactly one wins" holds here as it
// does in DynamoDB. Reads and writes can be made to fail, to stage an outage.
import type { MovePhase, MoveRecord, MoveRow } from "../src/move/record.ts";
import type { Placement } from "../src/placement.ts";
import type { AppRef } from "../src/registry.ts";

export class MemoryMoveRecord implements MoveRecord {
  readonly rows = new Map<string, MoveRow>();
  readonly log: string[] = [];
  failReads = 0;

  private row(orgId: string, appId: string): MoveRow | undefined {
    return this.rows.get(`${orgId}/${appId}`);
  }

  async read(orgId: string, appId: string): Promise<MoveRow | null> {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error("dynamodb unreachable");
    }
    const row = this.row(orgId, appId);
    return row ? { ...row } : null;
  }

  async begin(orgId: string, appId: string, from: string, to: string): Promise<number | null> {
    const key = `${orgId}/${appId}`;
    const row = this.rows.get(key);
    if (row && (row.vmId !== from || row.phase !== null)) return null;
    const version = (row?.version ?? 0) + 1;
    this.rows.set(key, { key, vmId: from, version, phase: "moving", targetVm: to });
    this.log.push("begin");
    return version;
  }

  private step(orgId: string, appId: string, version: number, from: MovePhase[], apply: (row: MoveRow) => void, name: string, me?: string): boolean {
    const row = this.row(orgId, appId);
    if (!row || row.version !== version || row.phase === null || !from.includes(row.phase)) return false;
    if (me !== undefined && row.targetVm !== me) return false;
    apply(row);
    this.log.push(name);
    return true;
  }

  async reportStopped(orgId: string, appId: string, version: number): Promise<boolean> {
    return this.step(orgId, appId, version, ["moving"], (r) => (r.phase = "a_stopped"), "a_stopped");
  }
  async cancel(orgId: string, appId: string, version: number): Promise<boolean> {
    return this.step(orgId, appId, version, ["moving", "a_stopped"], (r) => ((r.phase = null), (r.targetVm = null)), "cancel");
  }
  async claim(orgId: string, appId: string, version: number, me: string): Promise<boolean> {
    return this.step(orgId, appId, version, ["a_stopped"], (r) => (r.phase = "b_started"), "claim", me);
  }
  async finalize(orgId: string, appId: string, version: number, me: string): Promise<boolean> {
    return this.step(orgId, appId, version, ["b_started"], (r) => ((r.vmId = me), (r.version += 1), (r.phase = null), (r.targetVm = null)), "finalize", me);
  }
  async inFlight(): Promise<MoveRow[]> {
    return [...this.rows.values()].filter((r) => r.phase !== null).map((r) => ({ ...r }));
  }

  /** The holder as placement.ts reads a row: `b_started` = the target. */
  holder(orgId: string, appId: string, origin: string): string {
    const row = this.row(orgId, appId);
    if (!row) return origin;
    return (row.phase === "b_started" ? row.targetVm : row.vmId) ?? origin;
  }
}

/** Placement read from the shared record, with a cache only `reload` refreshes —
 *  like DdbPlacement between two expiries. */
export class RecordPlacement implements Placement {
  readonly cellId: string;
  private readonly record: MemoryMoveRecord;
  private readonly cache = new Map<string, string>();
  constructor(cellId: string, record: MemoryMoveRecord) {
    this.cellId = cellId;
    this.record = record;
  }
  async holderOf(orgId: string, appId: string): Promise<string> {
    const key = `${orgId}/${appId}`;
    if (!this.cache.has(key)) this.cache.set(key, this.record.holder(orgId, appId, "0"));
    return this.cache.get(key)!;
  }
  async isMine(orgId: string, appId: string): Promise<boolean> {
    return (await this.holderOf(orgId, appId)) === this.cellId;
  }
  async filterMine(refs: AppRef[]): Promise<AppRef[]> {
    const out: AppRef[] = [];
    for (const ref of refs) if (await this.isMine(ref.orgId, ref.appId)) out.push(ref);
    return out;
  }
  reload(): void {
    this.cache.clear();
  }
}
