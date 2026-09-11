import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type { StackContext } from "../context.ts";

export function createRegistryAlarms(stack: cdk.Stack, ctx: StackContext): void {
  // The registry table is the piece that says WHERE each customer database
  // lives, and it was the one thing on this stack nothing watched. The
  // connector's deploy package already alarms its own AppStateTable on the
  // same two metrics; the asymmetry had no reason, and this table is the more
  // critical of the two — a throttle here does not break one app, it breaks
  // the resolution of every database at once.
  //
  // Neither metric surfaces anywhere else: a DynamoDB throttle is not a Lambda
  // error (the `Errors` metric stays 0) and produces no gateway 5xx when the
  // caller retries, so without these it is visible only to someone reading the
  // console by hand. Baseline is a flat zero (measured over 24 h on all five
  // tables of the account, 2026-08-12), hence threshold 1 over a single 5 min
  // period — the same shape the connector uses.
  for (const [metricName, suffix] of [
    ["SystemErrors", "registry-system-errors"],
    ["ThrottledRequests", "registry-throttles"],
  ] as const) {
    const alarm = new cloudwatch.Alarm(stack, `Registry${metricName}Alarm`, {
      alarmName: `${stack.stackName}-${suffix}`,
      alarmDescription: `Dilaya SQLite Data API: RegistryTable ${metricName} >= 1 in 5 min (baseline is 0).`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/DynamoDB",
        metricName,
        dimensionsMap: { TableName: ctx.table.tableName },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 1,
      // NOT the dead-man treatment of the two above: no datapoint here means
      // no error happened, which is the healthy state.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(ctx.alertTopic));
    alarm.addOkAction(new cwActions.SnsAction(ctx.alertTopic));
  }
}
