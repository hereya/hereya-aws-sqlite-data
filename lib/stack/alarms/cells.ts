import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type { StackContext } from "../context.ts";
import { input } from "../inputs.ts";

/**
 * The origin's four alarms (liveness.ts, headroom.ts), once more per extra
 * cell — same thresholds, same topic, on the cell's OWN series.
 *
 * Not a convenience: the origin's alarms watch `{stack}`, which only the origin
 * publishes (service/src/metric-dimensions.ts). Without these a second cell
 * could die, fill its disk or run out of memory with every alarm green.
 */
export function createCellAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const action = new cwActions.SnsAction(ctx.alertTopic);
  const memoryHeadroomBytes = Number(input("memoryHeadroomBytes", String(150 * 1024 * 1024)));
  const diskHeadroomBytes = Number(input("diskHeadroomBytes", String(1.5 * 1024 * 1024 * 1024)));

  for (const { cellId, asg } of ctx.extraCells) {
    const dimensionsMap = { stack: stack.stackName, cell: cellId };
    const serviceMetric = (metricName: string, statistic: string, minutes: number) =>
      new cloudwatch.Metric({ namespace: "Dilaya/SqliteData", metricName, dimensionsMap, statistic, period: cdk.Duration.minutes(minutes) });
    const alarms = [
      new cloudwatch.Alarm(stack, `HeartbeatAlarmCell${cellId}`, {
        alarmName: `${stack.stackName}-cell${cellId}-heartbeat`,
        alarmDescription: `Dilaya SQLite Data API cell ${cellId}: heartbeat is silent (instance dead, service wedged, replication down, or network cut)`,
        metric: serviceMetric("Heartbeat", "Sum", 1),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
      new cloudwatch.Alarm(stack, `CapacityAlarmCell${cellId}`, {
        alarmName: `${stack.stackName}-cell${cellId}-no-instance`,
        alarmDescription: `The Data API ASG of cell ${cellId} has zero in-service instances`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/AutoScaling",
          metricName: "GroupInServiceInstances",
          dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
          statistic: "Minimum",
          period: cdk.Duration.minutes(1),
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
      // NOT breaching on missing data, like their origin twins: silence means
      // the heartbeat stopped, and that alarm already pages.
      new cloudwatch.Alarm(stack, `MemoryHeadroomAlarmCell${cellId}`, {
        alarmName: `${stack.stackName}-cell${cellId}-memory-headroom`,
        alarmDescription: `Available memory on the Data API VM of cell ${cellId} is low`,
        metric: serviceMetric("MemoryAvailableBytes", "Minimum", 5),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: memoryHeadroomBytes,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(stack, `DiskHeadroomAlarmCell${cellId}`, {
        alarmName: `${stack.stackName}-cell${cellId}-disk-headroom`,
        alarmDescription: `Free space on the Data API VM of cell ${cellId} is low — every write on that cell fails together when the volume fills`,
        metric: serviceMetric("DiskAvailableBytes", "Minimum", 5),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: diskHeadroomBytes,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }
  }
}
