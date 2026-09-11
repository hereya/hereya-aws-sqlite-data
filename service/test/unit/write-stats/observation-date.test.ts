// --- dating the observation ------------------------------------------------
//
// "This app has never been seen writing" is only worth acting on if we know how
// long we have been looking. These pin that clock: it must start once, survive
// a VM roll, and stay null rather than guess.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteStats, WRITE_STATS_PARTITION, OBSERVING_SINCE_KEY } from "../../../src/write-stats.ts";
import { fakeDdb, OPTS } from "./fake-ddb.ts";

test("the observation date is stamped once and never moved forward", async () => {
  const f = fakeDdb();
  let clock = 1_000;
  const first = new WriteStats({ ...OPTS, client: f.client as never, now: () => clock });

  assert.equal(await first.ensureObserving(), 1_000);
  assert.deepEqual(
    (f.updates[0]?.Key as Record<string, { S: string }>).org_id,
    { S: WRITE_STATS_PARTITION },
    "the date lives in the same fixed partition the instance role is scoped to",
  );
  assert.deepEqual((f.updates[0]?.Key as Record<string, { S: string }>).sk, { S: OBSERVING_SINCE_KEY });

  // A later boot — an instance replacement — must ADOPT the stored date, not
  // restart the clock. Restarting it is the exact failure that made the S3
  // timestamps useless, one level up.
  clock = 90 * 24 * 60 * 60 * 1000;
  const afterRoll = new WriteStats({ ...OPTS, client: f.client as never, now: () => clock });
  assert.equal(await afterRoll.ensureObserving(), 1_000, "a VM roll must not restart the observation");
  assert.equal(afterRoll.observedForMs(), clock - 1_000);
});

test("the stored date is picked up by load(), and is never mistaken for an app", async () => {
  // It shares the partition with the per-app rows. Every app key contains a
  // slash; this one does not — but the loader has to say so explicitly, or the
  // date would be counted as an app with no writes.
  const f = fakeDdb({
    items: [
      { sk: { S: OBSERVING_SINCE_KEY }, startedMs: { N: "5000" } },
      { sk: { S: "org/app" }, lastWriteMs: { N: "6000" }, writes: { N: "1" } },
    ],
  });
  const ws = new WriteStats({ ...OPTS, client: f.client as never, now: () => 65_000 });

  assert.equal(await ws.load(), 1, "the date is not an app");
  assert.equal(ws.observingSinceMs, 5_000);
  assert.equal(ws.observedForMs(), 60_000);
  assert.equal(ws.idleMsFor(OBSERVING_SINCE_KEY, ""), null);
});

test("a counter that cannot date itself reports null, not zero", async () => {
  // Zero would read as "watching since forever" and would make every unseen app
  // instantly evictable. Null is the only safe ignorance.
  const noTable = new WriteStats({ tableName: "", region: "eu-west-1" });
  assert.equal(await noTable.ensureObserving(), null);
  assert.equal(noTable.observedForMs(), null);

  const broken = new WriteStats({ ...OPTS, client: fakeDdb({ failUpdates: true }).client as never });
  await assert.doesNotReject(() => broken.ensureObserving(), "a statistic must never break a boot");
  assert.equal(broken.observedForMs(), null);
});
