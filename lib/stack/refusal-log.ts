import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type { StackContext } from "./context.ts";

/**
 * Where the VM ships its refused requests (service/src/refusals.ts,
 * t_dataapi_audit_cw). The NAME is derived from the stack, not exported as an
 * output: an output becomes one more env var on the connector's Lambda, whose
 * 4 KB is nearly spent, and a sweep can compute this name from the stack alone.
 *
 * Retention is a MONTH, against the access log's week: these lines are read to
 * attribute a spike AFTER a metric surfaced it, sometimes days later (the
 * 2026-10-02 spike was attributed on 10-03), and at ~10–250 lines a day the
 * month costs nothing.
 */
export function refusalLogGroupName(stackName: string): string {
  return `/dilaya/sqlite-data/${stackName}/refusals`;
}

export function createRefusalLog(stack: cdk.Stack, ctx: StackContext): void {
  const group = new logs.LogGroup(stack, "RefusalLog", {
    logGroupName: refusalLogGroupName(stack.stackName),
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  ctx.role.addToPolicy(
    new iam.PolicyStatement({
      sid: "RefusalLog",
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      // `logGroupArn` already ends in `:*`, which covers the group's streams.
      resources: [group.logGroupArn],
    }),
  );
  // The connector READS it (t_refusal_burst_analyser): a burst of SQL_ERROR
  // from one app becomes a fiche for that org. An `iamPolicy*` output is
  // attached to the connector's role and never lands in its Lambda env, so it
  // costs none of the 4 KB — the group NAME is still derived, not exported.
  new cdk.CfnOutput(stack, "iamPolicySqliteRefusalRead", {
    value: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["logs:FilterLogEvents"], Resource: [group.logGroupArn] }],
    }),
  });
}
