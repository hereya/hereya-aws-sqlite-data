// The network edge: no NAT, IAM-authorized routes, the VPC Link / Cloud Map
// path to the instance, and the access log that explains a failed call.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Template } from "aws-cdk-lib/assertions";
import { buildTemplate } from "./helpers.ts";

let template: Template;

before(() => {
  template = buildTemplate();
});

test("no NAT gateways and no interface endpoints (cost floor)", () => {
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
  for (const ep of Object.values(endpoints)) {
    assert.equal(ep.Properties.VpcEndpointType ?? "Gateway", "Gateway");
  }
});

test("every API route requires IAM (SigV4) authorization", () => {
  const routes = template.findResources("AWS::ApiGatewayV2::Route");
  const keys = Object.values(routes).map((r) => r.Properties.RouteKey as string);
  assert.ok(keys.length >= 7, `expected >=7 routes, got ${keys.join(", ")}`);
  for (const route of Object.values(routes)) {
    assert.equal(route.Properties.AuthorizationType, "AWS_IAM", `route ${route.Properties.RouteKey} must be IAM-authorized`);
  }
});

test("VPC Link + Cloud Map service exist; instance admits only the VPC Link SG", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::VpcLink", 1);
  template.resourceCountIs("AWS::ServiceDiscovery::Service", 1);
  const ingresses = template.findResources("AWS::EC2::SecurityGroupIngress");
  const toInstance = Object.values(ingresses);
  assert.equal(toInstance.length, 1, "exactly one ingress rule in the whole stack");
  assert.equal(toInstance[0]!.Properties.FromPort, 8080);
  assert.ok(toInstance[0]!.Properties.SourceSecurityGroupId, "ingress must be SG-scoped, not CIDR");
});

test("cloud map deregister-on-delete guards the service deletion", () => {
  const crs = template.findResources("Custom::CloudMapDeregister");
  const entries = Object.entries(crs);
  assert.equal(entries.length, 1);
  const [, cr] = entries[0]!;
  assert.ok(cr!.Properties.ServiceId, "must target the discovery service id");
  // the explicit dependency is what makes CloudFormation delete the custom
  // resource (and run its deregister) BEFORE deleting the service
  const deps: string[] = cr!.DependsOn ?? [];
  assert.ok(
    deps.some((d) => d.startsWith("NamespaceDataApiService")),
    "must depend on the discovery service",
  );
  // deregistration rights are scoped to this service (plus the unscoped
  // GetOperation poll — operations have no service ARN)
  const policies = template.findResources("AWS::IAM::Policy");
  const fnPolicy = Object.entries(policies).find(([k]) => k.startsWith("CloudMapDeregisterFn"));
  assert.ok(fnPolicy, "deregister fn must have an inline policy");
  const statements = fnPolicy![1]!.Properties.PolicyDocument.Statement as Array<{
    Action: string | string[];
    Resource: unknown;
  }>;
  const dereg = statements.find((s) => JSON.stringify(s.Action).includes("DeregisterInstance"));
  assert.ok(dereg, "must allow DeregisterInstance");
  assert.notEqual(JSON.stringify(dereg!.Resource), '"*"', "DeregisterInstance must be service-scoped");
});

// The gateway that serves EVERY customer database had no access log at all
// (t_dataapi_access_log): 20 087 requests in 24 h, 2 of them 5xx, and nothing
// anywhere said which app, which route, or why — only a counter saying "two".
// Its two sibling APIs (connector, landing) both log; this one, the layer where
// a failure means "a customer's data call failed", was the blind one.
test("the Data API stage writes an access log that says WHICH call failed and WHY", () => {
  const stages = template.findResources("AWS::ApiGatewayV2::Stage");
  const entries = Object.values(stages);
  assert.equal(entries.length, 1, "exactly one (default) stage");
  const settings = entries[0]!.Properties.AccessLogSettings;
  assert.ok(settings, "the stage MUST have access log settings — its 5xx are unattributable without them");
  assert.ok(settings.DestinationArn, "access log needs a destination log group");
  const format = JSON.parse(settings.Format as string);
  // The fields that answer WHAT failed and WHY, not just how many.
  for (const field of [
    "requestId",
    "routeKey",
    "status",
    "integrationStatus",
    "integrationErrorMessage",
    "sourceIp",
  ]) {
    assert.ok(format[field], `access log format must carry ${field}`);
  }
});

// Retention is a cost decision, not an accident: ~20 000 lines a day on a
// gateway whose logs are only ever read to explain a 5xx the metric window has
// already surfaced. Anything longer is paid for and never read.
test("the Data API access log group retains for one week, and is destroyed with the stack", () => {
  const stages = template.findResources("AWS::ApiGatewayV2::Stage");
  const dest = Object.values(stages)[0]!.Properties.AccessLogSettings.DestinationArn;
  const logicalId = (dest["Fn::GetAtt"] as [string, string])[0];
  const group = template.findResources("AWS::Logs::LogGroup")[logicalId];
  assert.ok(group, `access log destination ${logicalId} must be a log group in this stack`);
  assert.equal(group.Properties.RetentionInDays, 7);
  assert.equal(group.DeletionPolicy, "Delete");
});
