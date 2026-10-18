// The refusal log (t_dataapi_audit_cw): a log group with a name a sweep can
// derive from the stack alone, a retention, a write-only grant scoped to that
// group, the wire that tells the service where it is, and the connector's read grant.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Template } from "aws-cdk-lib/assertions";
import { buildTemplate } from "./helpers.ts";

let template: Template;

before(() => {
  template = buildTemplate();
});

test("the refusal log group is named from the stack and expires", () => {
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/dilaya/sqlite-data/TestStack/refusals",
    RetentionInDays: 30,
  });
});

test("the instance may only WRITE to that group", () => {
  const stmts = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => (p.Properties.PolicyDocument.Statement ?? []) as unknown[],
  ) as Array<{ Sid?: string; Action?: unknown; Resource?: unknown }>;
  const grant = stmts.find((st) => st.Sid === "RefusalLog");
  assert.ok(grant, "the RefusalLog grant must exist");
  assert.deepEqual(grant.Action, ["logs:CreateLogStream", "logs:PutLogEvents"]);
  const resource = JSON.stringify(grant.Resource);
  assert.ok(resource.includes("RefusalLog"), "scoped to the refusal group, never `*`");
  assert.ok(!resource.includes('"*"'));
});

test("the service is told where the group is (a switch with no wire ships nothing)", () => {
  for (const lt of Object.values(template.findResources("AWS::EC2::LaunchTemplate"))) {
    const userData = JSON.stringify(lt.Properties.LaunchTemplateData.UserData);
    assert.ok(userData.includes("REFUSAL_LOG_GROUP=/dilaya/sqlite-data/TestStack/refusals"), "every cell gets the env var");
  }
});

test("the connector may READ that group, and nothing more (t_refusal_burst_analyser)", () => {
  const out = template.findOutputs("iamPolicySqliteRefusalRead");
  const raw = JSON.stringify(out.iamPolicySqliteRefusalRead?.Value);
  assert.ok(raw, "the read grant must be exported as an iamPolicy* output");
  assert.ok(raw.includes("logs:FilterLogEvents"));
  assert.ok(!raw.includes("PutLogEvents") && !raw.includes('"*"'), "read-only, scoped to the group");
  assert.ok(raw.includes("RefusalLog"));
});
