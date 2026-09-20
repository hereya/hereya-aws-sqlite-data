// The small per-cell rules of t_dbmove_p3_relay_cells. Each of them has the
// same shape: the ORIGIN cell must keep behaving byte for byte as before — the
// roll that ships this has an old instance on one side — and any other cell
// must be kept apart from it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellKey } from "../../src/handover/keys.ts";
import { metricDimensions } from "../../src/metric-dimensions.ts";
import { DdbPlacement } from "../../src/placement.ts";
import { VmDirectory } from "../../src/vms.ts";

test("handover keys: the origin keeps the bare keys, another cell gets its own", () => {
  assert.equal(cellKey("current", undefined), "current");
  assert.equal(cellKey("current", "0"), "current");
  assert.equal(cellKey("current", "1"), "current#1");
  assert.notEqual(cellKey("warming", "1"), cellKey("warming", "2"));
});

test("metric dimensions: the origin's series is unchanged, another cell has its own", () => {
  assert.deepEqual(metricDimensions({ heartbeatDimension: "s", cellId: "0" }), [{ Name: "stack", Value: "s" }]);
  assert.deepEqual(metricDimensions({ heartbeatDimension: "s", cellId: "1" }), [
    { Name: "stack", Value: "s" },
    { Name: "cell", Value: "1" },
  ]);
});

function ddb(items: Record<string, unknown>[]) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  return {
    sent,
    client: {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        return { Items: items };
      },
    },
  };
}

const placed = (rows: Record<string, string | null>, cellId: string) =>
  new DdbPlacement({
    cellId,
    tableName: "t",
    region: "eu-west-1",
    cacheMs: 1000,
    client: ddb(Object.entries(rows).map(([sk, vmId]) => ({ sk: { S: sk }, ...(vmId ? { vmId: { S: vmId } } : {}) }))).client as never,
  });

test("placement: an ORG row places the org's apps; an app's own row wins; no row = the origin", async () => {
  const rows = { "org-new": "1", "org-new/app-pinned": "0" };
  const p = placed(rows, "1");
  assert.equal(await p.holderOf("org-new", "any-app"), "1");
  assert.equal(await p.holderOf("org-new", "app-pinned"), "0");
  assert.equal(await p.holderOf("org-old", "app"), "0");
  assert.deepEqual(
    await p.filterMine([
      { orgId: "org-new", appId: "x" },
      { orgId: "org-new", appId: "app-pinned" },
      { orgId: "org-old", appId: "y" },
    ]),
    [{ orgId: "org-new", appId: "x" }],
  );
});

test("placement: an ownerless APP row does not fall through to its org's row", async () => {
  const p = placed({ "org-new": "1", "org-new/broken": null }, "1");
  await assert.rejects(p.holderOf("org-new", "broken"), /no vmId/);
  assert.equal(await p.isMine("org-new", "fine"), true);
});

test("vm directory: only SERVING rows of the asked cell, newest announcement first", async () => {
  const row = (sk: string, state: string, atMs: number) => ({
    sk: { S: sk },
    ip: { S: "10.0.0.9" },
    port: { N: "8080" },
    state: { S: state },
    beat: { N: "3" },
    atMs: { N: String(atMs) },
  });
  const fake = ddb([
    row("1/i-old", "serving", 10),
    row("1/i-new", "serving", 20),
    row("1/i-gone", "retired", 30),
    row("1/i-dead", "evicted", 40),
    row("2/i-other", "serving", 50),
    { sk: { S: "garbage" } },
  ]);
  const dir = new VmDirectory({ tableName: "t", region: "eu-west-1", cacheMs: 1000, client: fake.client as never });
  assert.deepEqual((await dir.targets("1")).map((r) => r.instanceId), ["i-new", "i-old"]);
  await dir.targets("2");
  assert.equal(fake.sent.length, 1, "one consistent Query serves a burst");
  assert.equal(fake.sent[0]!.input.ConsistentRead, true);

  await dir.put({ cellId: "1", instanceId: "i-me", ip: "10.0.0.1", port: 8080 }, "serving", 4);
  const put = fake.sent[1]!.input.Item as Record<string, { S?: string }>;
  assert.equal(put.org_id!.S, "_vms");
  assert.equal(put.sk!.S, "1/i-me");
});
