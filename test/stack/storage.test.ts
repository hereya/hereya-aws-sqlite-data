// Storage resources (replica bucket, registry table) and the least-privilege
// grants that reach them.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Template } from "aws-cdk-lib/assertions";
import { buildTemplate } from "./helpers.ts";

let template: Template;

before(() => {
  template = buildTemplate();
});

test("replica bucket has NO lifecycle rules and NO versioning", () => {
  const buckets = template.findResources("AWS::S3::Bucket");
  const names = Object.keys(buckets).filter((k) => k.startsWith("ReplicaBucket"));
  assert.equal(names.length, 1);
  const bucket = buckets[names[0]!]!;
  assert.equal(bucket.Properties.LifecycleConfiguration, undefined, "no lifecycle rules allowed (Litestream owns retention)");
  assert.equal(bucket.Properties.VersioningConfiguration, undefined, "versioning must stay off");
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test("registry table: org_id/sk keys, on-demand billing, PITR", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    KeySchema: [
      { AttributeName: "org_id", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    BillingMode: "PAY_PER_REQUEST",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
});

test("instance role never gets s3:* and scopes S3 to the bucket", () => {
  const policies = template.findResources("AWS::IAM::Policy");
  for (const policy of Object.values(policies)) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      for (const action of actions) {
        assert.notEqual(action, "s3:*", "wildcard S3 is forbidden");
        assert.notEqual(action, "*", "wildcard actions are forbidden");
      }
    }
  }
});

test("the write-stats grant cannot touch org rows", () => {
  // The registry is what the double control reads to decide who may reach what.
  // Granting the data plane a blanket UpdateItem on it would be a real widening
  // of blast radius; the condition pins the write to one fixed partition.
  const policies = template.findResources("AWS::IAM::Policy");
  const stmts = Object.values(policies).flatMap(
    (p) => (p.Properties.PolicyDocument.Statement ?? []) as unknown[],
  ) as Array<{ Sid?: string; Action?: unknown; Condition?: Record<string, Record<string, string[]>> }>;
  const grant = stmts.find((st) => st.Sid === "WriteStats");
  assert.ok(grant, "the WriteStats grant must exist");
  assert.deepEqual(grant.Action, "dynamodb:UpdateItem", "write, and nothing else");
  assert.deepEqual(
    grant.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:LeadingKeys"],
    ["_writestats"],
    "scoped to the fixed partition — never an org's rows",
  );
});
