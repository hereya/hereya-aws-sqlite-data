// Placement (t_dbmove_p2_placement): a cell restores, serves and reconciles only
// the apps placed on it — and an app with no row belongs to the origin cell.
//
// The test that matters most is the reconcile one: `doSync` DELETES the local
// file of every served app missing from `listActive`. Unfiltered, a second cell
// would wipe a moved database the moment it reconciled; filtered wrongly (an
// unreadable placement read as "nothing is mine"), a cell would wipe its own.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AppManager } from "../../src/apps.ts";
import { ServiceError } from "../../src/errors.ts";
import type { Litestream, LitestreamApp } from "../../src/litestream.ts";
import { Limiter } from "../../src/limits.ts";
import { DdbPlacement, PlacedRegistry, parseCellId } from "../../src/placement.ts";
import type { Registry } from "../../src/registry.ts";
import { createGate } from "../../src/server/gate.ts";
import { AppSync } from "../../src/sync.ts";

const APPS = ["app-a", "app-b", "app-c"];

/** A `_placement` partition: `<org>/<app>` → row attributes. */
function fakeDdb(rows: Record<string, Record<string, string>>, opts: { pageSize?: number } = {}) {
  const state = { queries: 0, fail: false, inputs: [] as Record<string, unknown>[] };
  const client = {
    async send(cmd: { input: Record<string, unknown> }) {
      state.queries += 1;
      state.inputs.push(cmd.input);
      if (state.fail) throw new Error("ddb is down");
      const keys = Object.keys(rows).sort();
      const from = cmd.input.ExclusiveStartKey ? keys.indexOf((cmd.input.ExclusiveStartKey as { sk: { S: string } }).sk.S) + 1 : 0;
      const page = keys.slice(from, from + (opts.pageSize ?? 100));
      const last = page[page.length - 1];
      return {
        Items: page.map((sk) => ({
          sk: { S: sk },
          ...Object.fromEntries(Object.entries(rows[sk]!).map(([k, v]) => [k, { S: v }])),
        })),
        LastEvaluatedKey: from + page.length < keys.length && last ? { sk: { S: last } } : undefined,
      };
    },
  };
  return { client, state };
}

function placementFor(cellId: string, rows: Record<string, Record<string, string>>, extra = {}) {
  const ddb = fakeDdb(rows, extra);
  let clock = 0;
  const placement = new DdbPlacement({
    cellId,
    tableName: "t",
    region: "eu-west-1",
    cacheMs: 1000,
    client: ddb.client as never,
    now: () => clock,
  });
  return { placement, ddb: ddb.state, advance: (ms: number) => (clock += ms) };
}

const inner: Registry = {
  lookup: async () => "active",
  listActive: async () => APPS.map((appId) => ({ orgId: "org", appId })),
  reload: async () => {},
};

test("no placement row = the origin cell: an empty partition changes nothing", async () => {
  const origin = placementFor("0", {});
  const other = placementFor("1", {});
  assert.equal((await new PlacedRegistry(inner, origin.placement).listActive()).length, 3);
  assert.deepEqual(await new PlacedRegistry(inner, other.placement).listActive(), []);
  assert.equal(origin.ddb.inputs[0]!.ConsistentRead, true, "a stale placement is a second writer");
});

test("a placed app is listed by its cell and by no other — across pages", async () => {
  const rows = { "org/app-a": { vmId: "0" }, "org/app-b": { vmId: "1" } };
  const ids = async (cell: string) =>
    (await new PlacedRegistry(inner, placementFor(cell, rows, { pageSize: 1 }).placement).listActive()).map((r) => r.appId);
  assert.deepEqual(await ids("0"), ["app-a", "app-c"]);
  assert.deepEqual(await ids("1"), ["app-b"]);
});

test("the partition is read once per cache window, and one read serves a burst", async () => {
  const f = placementFor("0", {});
  await Promise.all([f.placement.isMine("org", "app-a"), f.placement.isMine("org", "app-b")]);
  await f.placement.isMine("org", "app-c");
  assert.equal(f.ddb.queries, 1);
  f.advance(1001);
  await f.placement.isMine("org", "app-a");
  assert.equal(f.ddb.queries, 2);
});

test("an unreadable placement THROWS — never 'mine', never 'not mine' — and is not cached", async () => {
  const f = placementFor("0", {});
  f.ddb.fail = true;
  await assert.rejects(f.placement.isMine("org", "app-a"), (e) => e instanceof ServiceError && e.code === "UNAVAILABLE");
  await assert.rejects(f.placement.filterMine([{ orgId: "org", appId: "app-a" }]), ServiceError);
  f.ddb.fail = false;
  assert.equal(await f.placement.isMine("org", "app-a"), true);
});

test("a row without an owner: THAT app is unavailable and held by nobody; the cell keeps serving", async () => {
  const f = placementFor("0", { "org/app-a": { phase: "moving" } });
  await assert.rejects(f.placement.isMine("org", "app-a"), /has no vmId/);
  assert.equal(await f.placement.isMine("org", "app-b"), true, "one malformed row must not take the cell down");
  const mine = await new PlacedRegistry(inner, f.placement).listActive();
  assert.deepEqual(mine.map((r) => r.appId), ["app-b", "app-c"], "never read as the origin's");
});

test("CELL_ID: absent = origin, and junk is refused at boot", () => {
  assert.equal(parseCellId(undefined), "0");
  assert.equal(parseCellId(""), "0");
  assert.equal(parseCellId("cell-2"), "cell-2");
  assert.throws(() => parseCellId("a/b"));
});

function syncFixture(placement: DdbPlacement) {
  const dir = mkdtempSync(join(tmpdir(), "placement-"));
  const dbPath = (o: string, a: string) => join(dir, o, a, "app.db");
  const ls = {
    async restoreIfMissing(app: LitestreamApp) {
      mkdirSync(dirname(app.dbPath), { recursive: true });
      writeFileSync(app.dbPath, "");
      return "restored" as const;
    },
    async apply() {},
  } as unknown as Litestream;
  const manager = { dbPath, removeApp: async () => {} } as unknown as AppManager;
  return { dir, dbPath, sync: new AppSync(new PlacedRegistry(inner, placement), manager, ls, 2) };
}

test("boot restores only this cell's apps", async () => {
  const f = syncFixture(placementFor("1", { "org/app-b": { vmId: "1" } }).placement);
  try {
    await f.sync.bootRestoreAll();
    assert.deepEqual(f.sync.servedApps.map((a) => a.appId), ["app-b"]);
    assert.equal(existsSync(f.dbPath("org", "app-a")), false, "another cell's database never lands here");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reconcile: a placement outage discards the pass — it never deletes this cell's files", async () => {
  const p = placementFor("0", {});
  const f = syncFixture(p.placement);
  try {
    await f.sync.bootRestoreAll();
    p.ddb.fail = true;
    await assert.rejects(f.sync.syncOnce(), ServiceError);
    for (const app of APPS) assert.equal(existsSync(f.dbPath("org", app)), true, `${app} survives`);
    assert.equal(f.sync.servedApps.length, 3);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reconcile: an app placed on another cell leaves this one; the rest stay", async () => {
  const rows: Record<string, Record<string, string>> = {};
  const p = placementFor("0", rows);
  const f = syncFixture(p.placement);
  try {
    await f.sync.bootRestoreAll();
    rows["org/app-b"] = { vmId: "1" };
    assert.deepEqual(await f.sync.syncOnce(), { added: 0, removed: 1 }, "reload drops the placement cache too");
    assert.equal(existsSync(f.dbPath("org", "app-b")), false);
    assert.equal(existsSync(f.dbPath("org", "app-a")), true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the gate refuses another cell's app with 421 BEFORE it could be restored here", async () => {
  const registry = new PlacedRegistry(inner, placementFor("0", { "org/app-b": { vmId: "1" } }).placement);
  const prepared: string[] = [];
  const gate = createGate({
    cfg: {} as never,
    registry,
    limiter: new Limiter({ maxPerApp: 4, maxTotal: 8 }),
    ensureServed: async (_o: string, appId: string) => void prepared.push(appId),
  } as never);
  await gate.authorize("org", "app-a");
  await assert.rejects(gate.authorize("org", "app-b"), (e) => e instanceof ServiceError && e.status === 421);
  assert.deepEqual(prepared, ["app-a"], "ensureServed on a misplaced app = a second litestream writer");
});

test("a move that reached `b_started` is held by its TARGET — before the row is finalized (t_dbmove_p4_move)", async () => {
  const rows = {
    "org/app-a": { vmId: "0", phase: "moving", targetVm: "1" },
    "org/app-b": { vmId: "0", phase: "a_stopped", targetVm: "1" },
    "org/app-c": { vmId: "0", phase: "b_started", targetVm: "1" },
  };
  const source = placementFor("0", rows).placement;
  const target = placementFor("1", rows).placement;
  assert.equal(await source.holderOf("org", "app-a"), "0");
  assert.equal(await source.holderOf("org", "app-b"), "0");
  // Before the claim the source may still cancel; from it on, BOTH sides agree.
  assert.equal(await source.isMine("org", "app-c"), false);
  assert.equal(await target.isMine("org", "app-c"), true);
  assert.deepEqual((await target.filterMine(APPS.map((appId) => ({ orgId: "org", appId })))).map((r) => r.appId), ["app-c"]);
});

test("the gate waits out a move and reads placement AFTER it — never restoring a database that just left", async () => {
  const limiter = new Limiter({ maxPerApp: 4, maxTotal: 8 });
  let holder = "0";
  const registry = { lookup: async () => "active", heldHere: async () => holder === "0" } as unknown as Registry;
  const prepared: string[] = [];
  const gate = createGate({ cfg: {} as never, registry, limiter, ensureServed: async (_o: string, a: string) => void prepared.push(a) } as never);
  const hold = limiter.hold("org/app-a", 5000);
  const waiting = gate.authorize("org", "app-a").then(() => "authorized", (e: ServiceError) => e.code);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(prepared, [], "parked BEFORE ensureServed — a promotion would re-register the database here");
  holder = "1"; // the move finished while it waited
  hold.release();
  assert.equal(await waiting, "MISPLACED");
  assert.deepEqual(prepared, []);
  limiter.close("org/app-b", "departing"), (holder = "0");
  await assert.rejects(gate.authorize("org", "app-b"), (e) => (e as ServiceError).code === "UNAVAILABLE");
  assert.deepEqual(prepared, []);
});
