// Stand-ins for relay.test.ts: placement as ONE cell believes it, and a directory.
import type { Placement } from "../../src/placement.ts";
import type { AppRef } from "../../src/registry.ts";
import type { PeerLookup, VmRow } from "../../src/vms.ts";

/** Placement as ONE cell believes it — each cell gets its own, so they can disagree. */
export class FakePlacement implements Placement {
  reloads = 0;
  readonly cellId: string;
  private holder: string;
  private readonly afterReload: string | undefined;
  constructor(cellId: string, holder: string, afterReload?: string) {
    this.cellId = cellId;
    this.holder = holder;
    this.afterReload = afterReload;
  }
  async holderOf(): Promise<string> {
    return this.holder;
  }
  async isMine(): Promise<boolean> {
    return this.holder === this.cellId;
  }
  async filterMine(refs: AppRef[]): Promise<AppRef[]> {
    return this.holder === this.cellId ? refs : [];
  }
  reload(): void {
    this.reloads += 1;
    if (this.afterReload !== undefined) this.holder = this.afterReload;
  }
}

export class FakePeers implements PeerLookup {
  rows: VmRow[] = [];
  reloads = 0;
  async targets(cellId: string): Promise<VmRow[]> {
    return this.rows.filter((r) => r.cellId === cellId);
  }
  async others(cellId: string): Promise<VmRow[]> {
    return this.rows.filter((r) => r.cellId !== cellId);
  }
  reload(): void {
    this.reloads += 1;
  }
  add(cellId: string, baseUrl: string): void {
    const port = Number(new URL(baseUrl).port);
    this.rows.push({ cellId, instanceId: `i-${cellId}-${port}`, ip: "127.0.0.1", port, state: "serving", beat: 0, atMs: 0 });
  }
}
