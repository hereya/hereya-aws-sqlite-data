// A database moves between two REAL services while a writer hammers it through
// both cells (t_dbmove_p4_move). Litestream and S3 are stood in by a shared
// directory — the final sync is "copy the closed file there", the restore is
// "copy it back" — so what this pins is everything AROUND them: the gate, the
// hold, the relay, the routes, the row. Every acknowledged write must be read
// back on the target, once.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { Arrival } from "../../src/move/arrival.ts";
import { Mover } from "../../src/move/mover.ts";
import { PlacedRegistry } from "../../src/placement.ts";
import { Relay } from "../../src/relay.ts";
import { MemoryMoveRecord, RecordPlacement } from "../move-fakes.ts";
import { FakePeers } from "./relay-fakes.ts";
import { call, startTestService, type TestService } from "../helpers.ts";

const ORG = "org-a";
const APP = "app-1";
const open: TestService[] = [];
after(async () => {
  for (const s of open) await s.close();
});

async function twoCells(): Promise<{ a: TestService; b: TestService; record: MemoryMoveRecord }> {
  const record = new MemoryMoveRecord();
  const peers = new FakePeers();
  const s3 = mkdtempSync(join(tmpdir(), "move-s3-"));
  const replica = join(s3, ORG, APP);
  const make = (cellId: string): Promise<TestService> => {
    const placement = new RecordPlacement(cellId, record);
    const relay = new Relay({ cellId, peers, timeoutMs: 5_000, connectTimeoutMs: 500 });
    let restore: (orgId: string, appId: string) => Promise<void> = async () => {};
    return startTestService(
      { cellId, moveDrainMs: 1_000 },
      {
        wrapRegistry: (inner) => new PlacedRegistry(inner, placement),
        relay,
        ensureServed: (orgId, appId) => restore(orgId, appId),
        moves: ({ manager, limiter, txRegistry, registry }) => {
          const local = (orgId: string, appId: string): string => dirname(manager.dbPath(orgId, appId));
          // "Restore-if-missing": what ensureServed does on the real service.
          restore = async (orgId, appId) => {
            if (existsSync(manager.dbPath(orgId, appId)) || !existsSync(replica)) return;
            mkdirSync(dirname(local(orgId, appId)), { recursive: true });
            cpSync(replica, local(orgId, appId), { recursive: true });
          };
          const reloadPlacement = (): void => registry.reloadPlacement?.();
          const out = new Mover({
            cellId,
            record,
            limiter,
            hasOpenTx: (k) => txRegistry.hasOpenTx(k),
            dbPath: (o, p) => manager.dbPath(o, p),
            served: {
              isPending: () => false,
              markDeparting: () => {},
              detach: async (o, p) => {
                await manager.removeApp(o, p); // closing the last connection folds the WAL in
                rmSync(replica, { recursive: true, force: true });
                cpSync(local(o, p), replica, { recursive: true });
              },
              reattach: async () => {},
              forget: (o, p) => rmSync(local(o, p), { recursive: true, force: true }),
            },
            askTarget: async (toCell, body) =>
              (await relay.forward(toCell, { method: "POST", path: "/admin/move-in", body: JSON.stringify(body) })).status,
            reloadPlacement,
            drainMs: 1_000,
            maxBytes: 64 * 1024 * 1024,
          });
          const arrival = new Arrival({
            cellId,
            record,
            limiter,
            clearForArrival: async (o, p) => rmSync(local(o, p), { recursive: true, force: true }),
            ensureServed: (o, p) => restore(o, p),
            reloadPlacement,
          });
          return { out, in: arrival };
        },
      },
    );
  };
  const a = await make("0");
  const b = await make("1");
  open.push(a, b);
  peers.add("0", a.baseUrl);
  peers.add("1", b.baseUrl);
  return { a, b, record };
}

const q = (sql: string) => ({ org_id: ORG, app_id: APP, sql });

test("moved under load: every acknowledged write is on the target, once — asked of the WRONG cell", async () => {
  const { a, b, record } = await twoCells();
  assert.equal((await call(a.baseUrl, "/query", q("CREATE TABLE t (v INTEGER)"))).status, 200);

  const acked: number[] = [];
  const refused: string[] = [];
  let stop = false;
  const writer = async (base: string, offset: number): Promise<void> => {
    for (let i = offset; !stop; i += 2) {
      const res = await call(base, "/query", q(`INSERT INTO t VALUES (${i})`)).catch((err: Error) => ({ status: 0, body: `${err.message} ${String(err.cause ?? "")}` }));
      if (res.status === 200) acked.push(i);
      else refused.push(`${res.status} ${JSON.stringify(res.body)}`); // judged below
    }
  };
  const writers = Promise.all([writer(a.baseUrl, 0), writer(b.baseUrl, 1)]);
  await sleep(150);
  // Asked of cell 1, which does not hold the app: relayed to the holder.
  const moved = await call(b.baseUrl, "/admin/move-app", { org_id: ORG, app_id: APP, to_cell: "1" }).finally(() => sleep(150));
  stop = true; // BEFORE any assertion: a writer left running keeps the process alive
  await writers;
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.status, "moved");

  assert.deepEqual(record.log, ["begin", "a_stopped", "claim", "finalize"]);
  const rows = await call(b.baseUrl, "/query", q("SELECT v FROM t ORDER BY v"));
  const onTarget = rows.body.records.map((r: Array<{ longValue: number }>) => r[0]!.longValue);
  assert.deepEqual(onTarget, [...acked].sort((x, y) => x - y));
  // Found on the real two-cell trial: a statement that entered through the
  // TARGET cell, was relayed to the source and parked there, came back as a
  // 421 once the app had arrived — and was answered 503 instead of served.
  assert.deepEqual(refused, [], "nobody sees the move: parked, then served where the app now is");
  const before = acked.filter((v) => v % 2 === 0).length;
  assert.ok(before > 3 && acked.length - before > 3, "both cells carried writes, before and after");
  // The source kept nothing it could serve, and still answers — through the relay.
  assert.equal(existsSync(join(a.dbDir, ORG, APP)), false);
  const viaSource = await call(a.baseUrl, "/query", q("SELECT count(*) FROM t"));
  assert.equal(viaSource.body.records[0][0].longValue, acked.length);
});

test("an open transaction makes the move give up — and the transaction commits as if nothing happened", async () => {
  const { a, b, record } = await twoCells();
  await call(a.baseUrl, "/query", q("CREATE TABLE t (v INTEGER)"));
  const tx = await call(a.baseUrl, "/tx/begin", { org_id: ORG, app_id: APP });
  await call(a.baseUrl, "/query", { ...q("INSERT INTO t VALUES (7)"), transactionId: tx.body.transactionId });
  const refusedMove = await call(a.baseUrl, "/admin/move-app", { org_id: ORG, app_id: APP, to_cell: "1" });
  assert.equal(refusedMove.status, 409);
  assert.equal(refusedMove.body.error.code, "MOVE_ABORTED");
  assert.deepEqual(record.log, []);
  const commit = await call(a.baseUrl, "/tx/commit", { org_id: ORG, app_id: APP, transactionId: tx.body.transactionId });
  assert.equal(commit.status, 200);
  assert.equal(existsSync(join(b.dbDir, ORG, APP)), false);
});

test("`/admin/move-in` is cell-to-cell only, and a move needs a real target", async () => {
  const { a } = await twoCells();
  const direct = await call(a.baseUrl, "/admin/move-in", { org_id: ORG, app_id: APP, version: 1 });
  assert.equal(direct.status, 400);
  assert.equal((await call(a.baseUrl, "/admin/move-app", { org_id: ORG, app_id: APP })).status, 400);
  await call(a.baseUrl, "/query", q("CREATE TABLE t (v INTEGER)"));
  // Nobody answers for cell 9: the move is cancelled and the app keeps serving here.
  const nowhere = await call(a.baseUrl, "/admin/move-app", { org_id: ORG, app_id: APP, to_cell: "9" });
  assert.equal(nowhere.body.status, "resumed", JSON.stringify(nowhere.body));
  assert.equal((await call(a.baseUrl, "/query", q("INSERT INTO t VALUES (1)"))).status, 200);
});
