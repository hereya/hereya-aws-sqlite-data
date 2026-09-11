// What the stack hands to its consumers: the artifact pointer, the capability
// secret, and the env contract the connector reads.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Match, type Template } from "aws-cdk-lib/assertions";
import { buildTemplate } from "./helpers.ts";

let template: Template;

before(() => {
  template = buildTemplate();
});

test("artifact pointer parameter exists (service-only update path)", () => {
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: Match.stringLikeRegexp("/TestStack/service-artifact"),
  });
});

test("capability secret is created, granted to the instance role, and exported", () => {
  template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  // RAW random string: no SecretStringTemplate/GenerateStringKey (GetSecretValue
  // returns the secret verbatim for both the service and the connector).
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
  });
  // the instance role must be able to read it (grantRead → GetSecretValue)
  const policies = template.findResources("AWS::IAM::Policy");
  const grantsGet = Object.values(policies).some((p) =>
    p.Properties.PolicyDocument.Statement.some((s: { Action?: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("secretsmanager:GetSecretValue");
    }),
  );
  assert.ok(grantsGet, "instance role must be granted secretsmanager:GetSecretValue");
  // new consumer outputs for the connector
  const outputs = template.findOutputs("*");
  assert.ok(outputs.capabilitySecretArn, "missing output capabilitySecretArn");
  assert.ok(outputs.iamPolicySqliteCapability, "missing output iamPolicySqliteCapability");
  const raw = JSON.stringify(outputs.iamPolicySqliteCapability!.Value);
  assert.ok(raw.includes("2012-10-17"));
  assert.ok(raw.includes("secretsmanager:GetSecretValue"));
});

test("exports the consumer env contract", () => {
  const outputs = template.findOutputs("*");
  for (const key of [
    "awsRegion",
    "sqliteReplicaBucketName",
    "registryTableName",
    "iamPolicySqliteRegistry",
    "dataApiUrl",
    "iamPolicySqliteDataApi",
  ]) {
    assert.ok(outputs[key], `missing output ${key}`);
  }
  // the policy value embeds the table ARN token, so at template level it is an
  // Fn::Join — just confirm the serialized shape carries the policy skeleton
  const raw = JSON.stringify(outputs.iamPolicySqliteRegistry!.Value);
  assert.ok(raw.includes("2012-10-17"));
  assert.ok(raw.includes("dynamodb:PutItem"));
  assert.ok(raw.includes("dynamodb:Scan")); // layer-sync sweep (connector)
});
