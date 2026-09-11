import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import type { StackContext } from "../context.ts";

export function createLivenessAlarms(stack: cdk.Stack, ctx: StackContext): void {
  // --- Heartbeat dead-man switch + Telegram relay (spec §3, « le silence est
  // interdit ») ------------------------------------------------------------
  const alertTopic = new sns.Topic(stack, "AlertTopic");
  ctx.alertTopic = alertTopic;

  const heartbeatAlarm = new cloudwatch.Alarm(stack, "HeartbeatAlarm", {
    alarmName: `${stack.stackName}-heartbeat`,
    alarmDescription:
      "Dilaya SQLite Data API heartbeat is silent (instance dead, service wedged, replication down, or network cut)",
    metric: new cloudwatch.Metric({
      namespace: "Dilaya/SqliteData",
      metricName: "Heartbeat",
      dimensionsMap: { stack: stack.stackName },
      statistic: "Sum",
      period: cdk.Duration.minutes(1),
    }),
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    threshold: 1,
    evaluationPeriods: 5,
    datapointsToAlarm: 3,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  heartbeatAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
  heartbeatAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

  const capacityAlarm = new cloudwatch.Alarm(stack, "CapacityAlarm", {
    alarmName: `${stack.stackName}-no-instance`,
    alarmDescription: "The Data API ASG has zero in-service instances",
    metric: new cloudwatch.Metric({
      namespace: "AWS/AutoScaling",
      metricName: "GroupInServiceInstances",
      dimensionsMap: { AutoScalingGroupName: ctx.asg.autoScalingGroupName },
      statistic: "Minimum",
      period: cdk.Duration.minutes(1),
    }),
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    threshold: 1,
    evaluationPeriods: 3,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  capacityAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
  capacityAlarm.addOkAction(new cwActions.SnsAction(alertTopic));
}
