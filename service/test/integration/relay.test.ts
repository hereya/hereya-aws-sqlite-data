// VM→VM relay (t_dbmove_p3_relay_cells): two real services, one per cell, and a
// request that lands on the wrong one.
//
// What is pinned here is what the CLIENT is told, because its retry policy acts
// on it: 503 is replayed (so it must mean "nothing ran"), a 500 with a code is
// not. And that a request crosses the wire between cells at most once.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { PlacedRegistry, type Placement } from "../../src/placement.ts";
import type { AppRef } from "../../src/registry.ts";
import { Relay, RELAY_HEADER } from "../../src/relay.ts";
import type { PeerLookup, VmRow } from "../../src/vms.ts";
import { call, startTestService, type TestService } from "../helpers.ts";

const ORG = "org-a";
const APP = "app-1";

/** Placement as ONE cell believes it — each cell gets its own, so they can disagree. */
class FakePlacement implements Placement {
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

class FakePeers implements PeerLookup {
  rows: VmRow[] = [];
  reloads = 0;
  async targets(cellId: string): Promise<VmRow[]> {
    return this.rows.filter((r) => r.cellId === cellId);
  }
  reload(): void {
    this.reloads += 1;
  }
  add(cellId: string, baseUrl: string): void {
    const port = Number(new URL(baseUrl).port);
    this.rows.push({ cellId, instanceId: `i-${cellId}-${port}`, ip: "127.0.0.1", port, state: "serving", beat: 0, atMs: 0 });
  }
}

const open: Array<{ close: () => Promise<void> }> = [];
after(async () => {
  for (const s of open) await s.close();
});

async function cell(placement: FakePlacement, peers: PeerLookup, extra = {}): Promise<TestService> {
  const svc = await startTestService(
    { cellId: placement.cellId },
    {
      wrapRegistry: (inner) => new PlacedRegistry(inner, placement),
      relay: new Relay({ cellId: placement.cellId, peers, timeoutMs: 5_000, connectTimeoutMs: 500 }),
      ...extra,
    },
  );
  open.push(svc);
  return svc;
}

const query = (sql: string) => ({ org_id: ORG, app_id: APP, sql });

test("a request for an app another cell holds is served by THAT cell, through this one", async () => {
  const peers = new FakePeers();
  const a = await cell(new FakePlacement("0", "1"), peers);
  const b = await cell(new FakePlacement("1", "1"), peers);
  peers.add("1", b.baseUrl);

  const created = await call(a.baseUrl, "/query", query("CREATE TABLE t (v TEXT)"));
  assert.equal(created.status, 200);
  const written = await call(a.baseUrl, "/query", query("INSERT INTO t VALUES ('via-a')"));
  assert.equal(written.body.numberOfRecordsUpdated, 1);

  // The file exists on the holder ONLY: the relaying cell restored nothing.
  assert.equal(existsSync(join(b.dbDir, ORG, APP, "app.db")), true);
  assert.equal(existsSync(join(a.dbDir, ORG, APP)), false);

  const direct = await call(b.baseUrl, "/query", query("SELECT v FROM t"));
  assert.equal(direct.body.records[0][0].stringValue, "via-a");

  // A transaction lives in the holder's memory; every step finds it again.
  const tx = await call(a.baseUrl, "/tx/begin", { org_id: ORG, app_id: APP });
  assert.equal(tx.status, 200);
  const inTx = await call(a.baseUrl, "/query", { ...query("INSERT INTO t VALUES ('in-tx')"), transactionId: tx.body.transactionId });
  assert.equal(inTx.status, 200);
  const commit = await call(a.baseUrl, "/tx/commit", { org_id: ORG, app_id: APP, transactionId: tx.body.transactionId });
  assert.equal(commit.status, 200);

  const stats = await call(a.baseUrl, `/stats?org_id=${ORG}&app_id=${APP}`);
  assert.equal(stats.status, 200);
  assert.ok(stats.body.dbSizeBytes > 0);

  // An error is the holder's error, verbatim — not a relay failure.
  const bad = await call(a.baseUrl, "/query", query("SELECT * FROM nope"));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "SQL_ERROR");
});

test("delete-app reaches the cell that has the file", async () => {
  const peers = new FakePeers();
  const deleted: string[] = [];
  const onDeleteApp = (where: string) => async (orgId: string, appId: string) => void deleted.push(`${where}:${orgId}/${appId}`);
  const a = await cell(new FakePlacement("0", "1"), peers, { onDeleteApp: onDeleteApp("a") });
  const b = await cell(new FakePlacement("1", "1"), peers, { onDeleteApp: onDeleteApp("b") });
  peers.add("1", b.baseUrl);

  const res = await call(a.baseUrl, "/admin/delete-app", { org_id: ORG, app_id: APP });
  assert.equal(res.status, 200);
  assert.deepEqual(deleted, [`b:${ORG}/${APP}`]);
});

test("a relayed request is never relayed again: two cells that disagree cost one hop, not a loop", async () => {
  const peers = new FakePeers();
  const placementB = new FakePlacement("1", "0"); // B believes the ORIGIN holds it
  const a = await cell(new FakePlacement("0", "1"), peers);
  const b = await cell(placementB, peers);
  peers.add("0", a.baseUrl);
  peers.add("1", b.baseUrl);

  const res = await call(a.baseUrl, "/query", query("SELECT 1"));
  // 503, which the client replays — true, since a 421 is answered before any statement.
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, "UNAVAILABLE");
  // B re-read its placement before telling a peer "not mine".
  assert.equal(placementB.reloads, 1);

  // And a client cannot make a cell relay by forging the header: it gets the 421.
  const forged = await call(a.baseUrl, "/query", query("SELECT 1"), { [RELAY_HEADER]: "9" });
  assert.equal(forged.status, 421);
});

test("a stale cache on the relaying cell heals itself: 421 → re-read → the right cell", async () => {
  const peers = new FakePeers();
  const a = await cell(new FakePlacement("0", "1", "2"), peers); // believes 1, the table says 2
  const b = await cell(new FakePlacement("1", "2"), peers);
  const c = await cell(new FakePlacement("2", "2"), peers);
  peers.add("1", b.baseUrl);
  peers.add("2", c.baseUrl);

  const res = await call(a.baseUrl, "/query", query("CREATE TABLE healed (v TEXT)"));
  assert.equal(res.status, 200);
  assert.equal(existsSync(join(c.dbDir, ORG, APP, "app.db")), true);
  assert.equal(existsSync(join(b.dbDir, ORG, APP)), false);
});

test("a peer that never accepted the connection = 503 (nothing ran); one that dropped it after = 500 (it may have)", async () => {
  // Never connected: a port nobody listens on.
  const deadPeers = new FakePeers();
  const a = await cell(new FakePlacement("0", "1"), deadPeers);
  deadPeers.add("1", "http://127.0.0.1:1");
  const refused = await call(a.baseUrl, "/query", query("INSERT INTO t VALUES (1)"));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "UNAVAILABLE");
  assert.ok(deadPeers.reloads >= 1, "the directory is re-read so the next try finds a successor");

  // Connected, then the socket died mid-request: the statement may have run.
  const rude: Server = createServer((req) => req.socket.destroy());
  await new Promise<void>((r) => rude.listen(0, r));
  open.push({ close: () => new Promise<void>((r) => rude.close(() => r())) });
  const rudePeers = new FakePeers();
  const a2 = await cell(new FakePlacement("0", "1"), rudePeers);
  rudePeers.add("1", `http://127.0.0.1:${(rude.address() as { port: number }).port}`);
  const dropped = await call(a2.baseUrl, "/query", query("INSERT INTO t VALUES (1)"));
  assert.equal(dropped.status, 500);
  assert.equal(dropped.body.error.code, "INTERNAL");
});

test("with two instances in a cell (a roll), a dead one costs a try, not the request", async () => {
  const peers = new FakePeers();
  const a = await cell(new FakePlacement("0", "1"), peers);
  const b = await cell(new FakePlacement("1", "1"), peers);
  peers.add("1", "http://127.0.0.1:1"); // the departed instance, listed first
  peers.add("1", b.baseUrl);
  const res = await call(a.baseUrl, "/query", query("SELECT 1 AS one"));
  assert.equal(res.status, 200);
});

test("no cell announced for the holder = 503, and the directory is re-read first", async () => {
  const peers = new FakePeers();
  const a = await cell(new FakePlacement("0", "1"), peers);
  const res = await call(a.baseUrl, "/query", query("SELECT 1"));
  assert.equal(res.status, 503);
  assert.ok(peers.reloads >= 1);
});
