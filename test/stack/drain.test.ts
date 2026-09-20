// Emptying a cell, as the STACK sees it (t_dbmove_p5_drain_ops): the two gateway
// routes, an AMI per cell, and the alarms on what the capacity alarms cannot see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PINNED_AMI_ID } from "../../lib/ami-pin.ts";
import { amiIdForCell } from "../../lib/stack/machine-image.ts";
import { buildTemplate } from "./helpers.ts";

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

type Template = ReturnType<typeof buildTemplate>;
const routeKeys = (t: Template): string[] => Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
const alarmNames = (t: Template): string[] => Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => String((a as { Properties: { AlarmName: unknown } }).Properties.AlarmName)).sort();
/** cell id → ImageId of its launch template. */
function images(t: Template): Record<string, string> {
  return Object.fromEntries(
    Object.values(t.findResources("AWS::EC2::LaunchTemplate")).map((lt) => {
      const text = JSON.stringify(lt);
      const data = (lt as { Properties: { LaunchTemplateData: { ImageId: string } } }).Properties.LaunchTemplateData;
      return [/CELL_ID=["']?([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "?", data.ImageId];
    }),
  );
}

test("the drain routes are gateway routes; move-in still is not", () => {
  const keys = routeKeys(buildTemplate());
  assert.ok(keys.includes("POST /admin/drain-cell"));
  assert.ok(keys.includes("POST /admin/drain-status"));
  assert.ok(!keys.includes("POST /admin/move-in"));
});

test("amiIdByCell names the cells it overrides, and only those", () => {
  assert.equal(amiIdForCell("0", "ami-pin", ""), "ami-pin");
  assert.equal(amiIdForCell("0", "ami-pin", "0=ami-old"), "ami-old");
  assert.equal(amiIdForCell("1", "ami-pin", "0=ami-old"), "ami-pin");
  assert.equal(amiIdForCell("2", "ami-pin", " 0=ami-old , 2=ami-x "), "ami-x");
  assert.throws(() => amiIdForCell("0", "ami-pin", "0"), /invalid amiIdByCell/);
  assert.throws(() => amiIdForCell("0", "ami-pin", "0=a=b"), /invalid amiIdByCell/);
});

test("holding the origin on the old image while cell 1 takes the pin — the deploy that precedes a drain", () => {
  const t = withEnv({ vmCount: "2", amiIdByCell: "0=ami-0123456789abcdef0" }, () => buildTemplate());
  assert.deepEqual(images(t), { "0": "ami-0123456789abcdef0", "1": PINNED_AMI_ID });
});

test("without the override every cell runs the pin, and a bogus id still fails at synth", () => {
  const t = withEnv({ vmCount: "2" }, () => buildTemplate());
  assert.deepEqual(images(t), { "0": PINNED_AMI_ID, "1": PINNED_AMI_ID });
  assert.throws(() => withEnv({ amiIdByCell: "0=not-an-ami" }, () => buildTemplate()), /amiId must be an AMI id/);
});

test("one cell: the lag alarm exists, the move and relay alarms do not (nobody would publish them)", () => {
  const names = alarmNames(buildTemplate()).join("\n");
  assert.match(names, /replication-lag/);
  assert.doesNotMatch(names, /move-stuck|relay-failures/);
});

test("two cells: three alarms per cell, each on its own series, none breaching on silence", () => {
  const t = withEnv({ vmCount: "2" }, () => buildTemplate());
  const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((a) => (a as { Properties: Record<string, unknown> }).Properties);
  const ours = alarms.filter((p) => ["ReplicationLagMaxSeconds", "MovesStuck", "RelayFailures"].includes(String(p.MetricName)));
  assert.equal(ours.length, 6);
  for (const p of ours) assert.equal(p.TreatMissingData, "notBreaching");
  const cellsOf = (metric: string) => ours.filter((p) => p.MetricName === metric).map((p) => (p.Dimensions as { Name: string; Value: string }[]).find((d) => d.Name === "cell")?.Value ?? "origin").sort();
  assert.deepEqual(cellsOf("MovesStuck"), ["1", "origin"]);
  assert.deepEqual(cellsOf("ReplicationLagMaxSeconds"), ["1", "origin"]);
});
