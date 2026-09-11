import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { StackContext } from "./context.ts";

export function createHttpApi(stack: cdk.Stack, ctx: StackContext): void {
  const vpcLink = new apigwv2.VpcLink(stack, "VpcLink", {
    vpc: ctx.vpc,
    subnets: { subnetType: ec2.SubnetType.PUBLIC },
    securityGroups: [ctx.vpcLinkSg],
  });
  ctx.vpcLink = vpcLink;

  const httpApi = new apigwv2.HttpApi(stack, "HttpApi", {
    apiName: `${stack.stackName}-sqlite-data`,
    defaultAuthorizer: new HttpIamAuthorizer(),
  });
  ctx.httpApi = httpApi;
  const integration = new HttpServiceDiscoveryIntegration("DataApi", ctx.discoveryService, { vpcLink });
  for (const [method, path] of [
    [apigwv2.HttpMethod.POST, "/query"],
    [apigwv2.HttpMethod.POST, "/batch-execute"],
    [apigwv2.HttpMethod.POST, "/tx/begin"],
    [apigwv2.HttpMethod.POST, "/tx/commit"],
    [apigwv2.HttpMethod.POST, "/tx/rollback"],
    [apigwv2.HttpMethod.POST, "/admin/sync"],
    [apigwv2.HttpMethod.POST, "/admin/delete-app"],
    [apigwv2.HttpMethod.GET, "/stats"],
    [apigwv2.HttpMethod.GET, "/health"],
  ] as const) {
    httpApi.addRoutes({ path, methods: [method], integration });
  }

  // --- Access log: whose data call failed, and why (t_dataapi_access_log) ---
  // This gateway serves EVERY app's database of EVERY org, and until now it
  // was the only one of our three with `AccessLogSettings` unset — the
  // connector's API and the landing's both log. The 2026-08-28 sweep measured
  // 20 087 requests in 24 h with 2 in 5xx, and nothing could say which app,
  // which route, which caller, or whether the integration had even been
  // reached: the `AWS/ApiGateway 5xx` metric counts failures, it never names
  // them. That is the wrong blind spot to keep on the layer where a failure
  // means "a customer's data call failed".
  //
  // Same field set as the connector's API, so one habit reads both.
  // Retention is deliberately ONE WEEK: these lines are only ever read to
  // explain a 5xx that a metric window already surfaced, and at ~20 000 lines
  // a day anything longer is paid for and never read.
  const accessLogGroup = new logs.LogGroup(stack, "HttpApiAccessLogs", {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  // Access-log settings live only on the L1 stage — `HttpApi` exposes no prop
  // for them, and `defaultStage` is created for us by `createDefaultStage`.
  const cfnDefaultStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
  cfnDefaultStage.accessLogSettings = {
    destinationArn: accessLogGroup.logGroupArn,
    // One JSON object per request, ordered by what a sweep actually reads:
    // WHAT (route/status), then WHY (the integration fields — a 5xx with no
    // `integrationStatus` never reached the VM at all, which is a different
    // fault from one the VM answered), then WHO (a caller of ours, or not).
    format: JSON.stringify({
      requestId: "$context.requestId",
      requestTime: "$context.requestTime",
      httpMethod: "$context.httpMethod",
      routeKey: "$context.routeKey",
      path: "$context.path",
      status: "$context.status",
      integrationStatus: "$context.integrationStatus",
      integrationErrorMessage: "$context.integrationErrorMessage",
      integrationLatency: "$context.integrationLatency",
      responseLatency: "$context.responseLatency",
      errorMessage: "$context.error.message",
      sourceIp: "$context.identity.sourceIp",
      userAgent: "$context.identity.userAgent",
    }),
  };
}
