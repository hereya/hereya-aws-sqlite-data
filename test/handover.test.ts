// The handover protocol's safety properties (t_vm_zero_cut_handover).
//
// This is the most dangerous code in the package: it deliberately creates the
// state the ASG exists to prevent — two instances alive at once — so what is
// pinned here is not "does it work" but "can it ever let both write".
//
// The four properties, in the order they matter:
//   1. A stale record NEVER counts as a handover (the record is one durable
//      item reused across every roll, so this is the whole difference between
//      waiting and starting on a stop that happened days ago).
//   2. An unreadable store reads as "no proof", never as permission.
//   3. A timeout is reported as its own outcome, never disguised as success.
//   4. The catch-up list includes a write that landed DURING the warm-up, and
//      an instance that cannot enumerate its writes says so instead of
//      claiming nothing changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitHandover, publishHandover } from "../service/src/handover/protocol.ts";
import { HANDOVER_KEY, HANDOVER_PARTITION, isFresh, type HandoverRecord } from "../service/src/handover/record.ts";
import { dirtySince, splitAppKey } from "../service/src/handover/dirty.ts";
import type { WriteStat } from "../service/src/write-stats/stat.ts";

/** A DynamoDB stand-in holding one item, or failing on demand. */
function fakeDdb(opts: { item?: Record<string, unknown> | null; fail?: boolean } = {}) {
  let item = opts.item ?? null;
  const puts: Record<string, unknown>[] = [];
  return {
    puts,
    get current() {
      return item;
    },
    client: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (opts.fail) throw new Error("dynamodb unavailable");
        if (cmd.constructor.name === "PutItemCommand") {
          item = cmd.input.Item as Record<string, unknown>;
          puts.push(item);
          return {};
        }
        return { Item: item ?? undefined };
      },
    } as never,
    tableName: "registry",
  };
}

const stat = (lastWriteMs: number): WriteStat => ({ lastWriteMs, writes: 1, lastTouchMs: lastWriteMs });

test("a record from a PREVIOUS roll is not a handover", () => {
  const old: HandoverRecord = { fromInstanceId: "i-old", atMs: 1_000, dirtyApps: [] };
  // The replacement started warming at 5_000; the record predates it.
  assert.equal(isFresh(old, 5_000), false);
  assert.equal(isFresh({ ...old, atMs: 5_001 }, 5_000), true);
  // Equal instants do NOT count: the record must be published after we started.
  assert.equal(isFresh({ ...old, atMs: 5_000 }, 5_000), false);
  assert.equal(isFresh(null, 0), false);
});

test("a stale record makes the replacement WAIT, then time out — it never starts on it", async () => {
  // The exact trap this guards: one durable item survives every handover, so a
  // replacement that did not compare instants would read a months-old stop and
  // start writing while the current instance still is.
  const store = fakeDdb({
    item: {
      org_id: { S: HANDOVER_PARTITION },
      sk: { S: HANDOVER_KEY },
      fromInstanceId: { S: "i-from-last-month" },
      atMs: { N: "1000" },
      dirtyApps: { L: [] },
    },
  });
  let clock = 50_000;
  const outcome = await awaitHandover(
    { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) },
    { warmStartedAt: 49_000, timeoutMs: 2_000 },
  );
  assert.equal(outcome.reason, "timeout");
});

test("an unreadable store is 'no proof', not permission", async () => {
  const store = fakeDdb({ fail: true });
  let clock = 0;
  const outcome = await awaitHandover(
    { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) },
    { warmStartedAt: 0, timeoutMs: 1_500 },
  );
  assert.equal(outcome.reason, "timeout", "a read failure must never resolve as a handover");
});

test("a fresh record is observed, and carries the catch-up list", async () => {
  const store = fakeDdb();
  let clock = 10_000;
  const deps = { client: store.client, tableName: store.tableName, now: () => clock, sleep: async () => void (clock += 500) };

  // The old instance publishes only once litestream has exited.
  clock = 10_400;
  await publishHandover(deps, { instanceId: "i-old", dirtyApps: ["org-a/app-1", "org-b/app-2"] });

  clock = 10_500;
  const outcome = await awaitHandover(deps, { warmStartedAt: 10_000, timeoutMs: 5_000 });
  assert.equal(outcome.reason, "handover");
  if (outcome.reason !== "handover") return;
  assert.equal(outcome.record.fromInstanceId, "i-old");
  assert.deepEqual(outcome.record.dirtyApps, ["org-a/app-1", "org-b/app-2"]);
  assert.equal(outcome.record.dirtyUnknown, false);
});

test("an instance that cannot list its writes says UNKNOWN, never 'nothing changed'", async () => {
  const store = fakeDdb();
  const deps = { client: store.client, tableName: store.tableName, now: () => 1_000 };
  await publishHandover(deps, { instanceId: "i-old", dirtyApps: null });
  const outcome = await awaitHandover({ ...deps, now: () => 1_100 }, { warmStartedAt: 0, timeoutMs: 100 });
  assert.equal(outcome.reason, "handover");
  if (outcome.reason !== "handover") return;
  // Claiming an empty list here would make the replacement skip the catch-up
  // and serve a stale database — the one silent-data-loss shape in this design.
  assert.equal(outcome.record.dirtyUnknown, true);
});

test("publishing never throws, so a dying instance still dies cleanly", async () => {
  const store = fakeDdb({ fail: true });
  const ok = await publishHandover(
    { client: store.client, tableName: store.tableName, now: () => 1 },
    { instanceId: "i-old", dirtyApps: [] },
  );
  assert.equal(ok, false, "it reports failure rather than raising it into the shutdown path");
});

test("the catch-up list includes a write that landed DURING the warm-up", () => {
  const warmStartedAt = 1_000;
  const stats = new Map<string, WriteStat>([
    ["org/before", stat(900)], // written before we started restoring — our copy has it
    ["org/during", stat(1_500)], // written while we restored — our copy is STALE
    ["org/at-boundary", stat(1_000)], // same millisecond — conservative: include
    ["org/never", { lastWriteMs: 0, writes: 0, lastTouchMs: 2_000 }], // read-only
  ]);
  assert.deepEqual(dirtySince(stats, warmStartedAt), ["org/at-boundary", "org/during"]);
});

test("app keys round-trip, and a malformed one is refused rather than guessed", () => {
  assert.deepEqual(splitAppKey("11111111-2222-3333-4444-555555555555/app-9"), {
    orgId: "11111111-2222-3333-4444-555555555555",
    appId: "app-9",
  });
  assert.equal(splitAppKey("no-slash"), null);
  assert.equal(splitAppKey("/leading"), null);
  assert.equal(splitAppKey("trailing/"), null);
});
