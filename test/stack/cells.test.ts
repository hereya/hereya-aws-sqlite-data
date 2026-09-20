// N cells in one stack (t_dbmove_p3_relay_cells).
//
// Two things are pinned. With vmCount at its default the stack is the ONE cell
// production runs — no extra resource, no opened port. And a second cell shares
// everything a client can see (gateway, discovery, role, table) while owning
// everything the single-writer invariant is scoped by (its group, its hook, its
// CELL_ID, its alarms).
import { test } from "node:test";
import assert from "node:assert/strict";
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
const count = (t: Template, type: string) => Object.keys(t.findResources(type)).length;

/** The CELL_ID each launch template boots its service with. */
function cellIds(t: Template): string[] {
  return Object.values(t.findResources("AWS::EC2::LaunchTemplate"))
    .map((lt) => /CELL_ID=["']?([A-Za-z0-9_-]+)/.exec(JSON.stringify(lt))?.[1] ?? "?")
    .sort();
}

function selfIngress(t: Template): unknown[] {
  return Object.values(t.findResources("AWS::EC2::SecurityGroupIngress")).filter((r) => {
    const p = (r as { Properties: Record<string, unknown> }).Properties;
    return JSON.stringify(p.GroupId) === JSON.stringify(p.SourceSecurityGroupId);
  });
}

test("default: ONE cell, the origin — and no VM→VM port is opened for a relay nobody needs", () => {
  const t = buildTemplate();
  assert.equal(count(t, "AWS::AutoScaling::AutoScalingGroup"), 1);
  assert.deepEqual(cellIds(t), ["0"]);
  assert.equal(selfIngress(t).length, 0);
  assert.equal(count(t, "AWS::CloudWatch::Alarm"), count(withEnv({ vmCount: "1" }, buildTemplate), "AWS::CloudWatch::Alarm"));
});

test("vmCount=2: a second group with its own CELL_ID, behind the SAME gateway and discovery service", () => {
  const one = buildTemplate();
  const two = withEnv({ vmCount: "2" }, buildTemplate);
  assert.equal(count(two, "AWS::AutoScaling::AutoScalingGroup"), 2);
  assert.deepEqual(cellIds(two), ["0", "1"]);
  for (const shared of ["AWS::ApiGatewayV2::Api", "AWS::ServiceDiscovery::Service", "AWS::IAM::Role", "AWS::DynamoDB::Table", "AWS::S3::Bucket"]) {
    assert.equal(count(two, shared), count(one, shared), `${shared} must be shared, not per cell`);
  }
  // The origin's resources keep their logical ids: adding a cell must not
  // REPLACE the group that holds production's databases.
  const ids = (t: Template, type: string) => Object.keys(t.findResources(type));
  for (const type of ["AWS::AutoScaling::AutoScalingGroup", "AWS::EC2::LaunchTemplate"]) {
    for (const id of ids(one, type)) assert.ok(ids(two, type).includes(id), `${id} disappeared`);
  }
});

test("vmCount=2: the instances may reach each other on the service port, and only on it", () => {
  const t = withEnv({ vmCount: "2", servicePort: "8080" }, buildTemplate);
  const rules = selfIngress(t) as { Properties: Record<string, unknown> }[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.Properties.FromPort, 8080);
  assert.equal(rules[0]!.Properties.ToPort, 8080);
  assert.equal(rules[0]!.Properties.IpProtocol, "tcp");
});

test("vmCount=2: the second cell has its own four alarms, on its OWN series", () => {
  const one = buildTemplate();
  const two = withEnv({ vmCount: "2" }, buildTemplate);
  // +4 capacity alarms and +1 replication lag for cell 1, +2 per cell (move
  // stuck, relay failures) that only exist with several cells (alarms/moves.ts).
  assert.equal(count(two, "AWS::CloudWatch::Alarm"), count(one, "AWS::CloudWatch::Alarm") + 4 + 1 + 2 * 2);
  const heartbeats = Object.values(two.findResources("AWS::CloudWatch::Alarm"))
    .map((a) => (a as { Properties: { MetricName: string; Dimensions: { Name: string; Value: unknown }[] } }).Properties)
    .filter((p) => p.MetricName === "Heartbeat");
  assert.equal(heartbeats.length, 2);
  // One watches {stack} (the origin, unchanged), the other {stack, cell=1}: a
  // shared series would keep Sum >= 1 while EITHER cell lives.
  assert.deepEqual(heartbeats.map((p) => p.Dimensions.map((d) => d.Name).sort().join(",")).sort(), ["cell,stack", "stack"]);
  const celled = heartbeats.find((p) => p.Dimensions.length === 2)!;
  assert.equal(celled.Dimensions.find((d) => d.Name === "cell")!.Value, "1");
});

test("handover ON reshapes EVERY cell's group — a cell left terminate-before-launch would wait for nobody", () => {
  const t = withEnv({ vmCount: "2", handoverEnabled: "true" }, buildTemplate);
  const groups = Object.values(t.findResources("AWS::AutoScaling::AutoScalingGroup")) as {
    Properties: Record<string, unknown>;
  }[];
  assert.equal(groups.length, 2);
  for (const g of groups) {
    assert.equal(g.Properties.MaxSize, "2");
    assert.ok(Array.isArray(g.Properties.LifecycleHookSpecificationList));
    assert.equal(g.Properties.CapacityRebalance, false);
  }
});

test("the vm directory grant reaches the `_vms` partition and nothing else", () => {
  const policies = JSON.stringify(buildTemplate().findResources("AWS::IAM::Policy"));
  const statement = /\{[^{}]*"Sid":"VmDirectory"[^{}]*\}|\{"Action":\["dynamodb:PutItem","dynamodb:DeleteItem"\].*?"Sid":"VmDirectory"\}/.exec(policies)?.[0];
  assert.ok(statement, "VmDirectory statement not found");
  assert.match(statement, /"dynamodb:LeadingKeys":\["_vms"\]/);
  assert.doesNotMatch(statement, /UpdateItem|BatchWrite|dynamodb:\*/);
});

test("the move grant is conditional writes on `_placement` and nothing else; the gateway routes move-app, never move-in", () => {
  const template = buildTemplate();
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) => (policy as { Properties: { PolicyDocument: { Statement: Array<{ Sid?: string }> } } }).Properties.PolicyDocument.Statement,
  );
  const found = statements.find((st) => st.Sid === "PlacementMoves");
  const statement = found && JSON.stringify(found);
  assert.ok(statement, "PlacementMoves statement not found");
  assert.match(statement, /"dynamodb:LeadingKeys":\["_placement"\]/);
  assert.match(statement, /"Action":"dynamodb:UpdateItem"/);
  assert.doesNotMatch(statement, /PutItem|DeleteItem|BatchWrite|dynamodb:\*/);
  const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
  assert.ok(routes.includes("POST /admin/move-app"));
  assert.ok(!routes.some((r) => r.includes("move-in")));
});

test("a vmCount that is not a whole number of cells is refused at synth", () => {
  for (const bad of ["0", "2.5", "many", "9"]) {
    assert.throws(() => withEnv({ vmCount: bad }, buildTemplate), /invalid vmCount/);
  }
});
