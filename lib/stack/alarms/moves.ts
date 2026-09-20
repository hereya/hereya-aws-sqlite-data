import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import { readVmCount } from "../cells.ts";
import type { StackContext } from "../context.ts";
import { input } from "../inputs.ts";

/**
 * What the capacity alarms cannot see (t_dbmove_p5_drain_ops) — per cell, on the
 * series service/src/cell-gauges.ts publishes:
 *
 * - **replication lag**: litestream is up (the heartbeat says so) and ONE
 *   database has stopped reaching S3. Every write to it since is one a crash
 *   loses. Created for every cell, the origin included.
 * - **move stuck** and **relay failures**: only with several cells — with one
 *   there is nothing to move and nobody to relay to, and an alarm on a series
 *   nobody publishes would sit in INSUFFICIENT_DATA for ever.
 *
 * All three are NOT breaching on missing data: silence is the heartbeat's alarm.
 * The relay RATE is published and deliberately not alarmed: with N cells,
 * (N-1)/N of the traffic is relayed by design.
 */
export function createMoveAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const action = new cwActions.SnsAction(ctx.alertTopic);
  const lagSeconds = Number(input("replicationLagAlarmSeconds", "300"));
  if (!Number.isFinite(lagSeconds) || lagSeconds < 30) {
    throw new Error(`invalid replicationLagAlarmSeconds: ${input("replicationLagAlarmSeconds", "300")} (expected seconds, >= 30)`);
  }
  const severalCells = readVmCount() > 1;
  const cells = ["0", ...ctx.extraCells.map((c) => c.cellId)];
  for (const cellId of cells) {
    // The origin keeps the bare `{stack}` series (service/src/metric-dimensions.ts).
    const dimensionsMap: Record<string, string> = cellId === "0" ? { stack: stack.stackName } : { stack: stack.stackName, cell: cellId };
    const suffix = cellId === "0" ? "" : `Cell${cellId}`;
    const name = cellId === "0" ? stack.stackName : `${stack.stackName}-cell${cellId}`;
    const metric = (metricName: string, statistic: string, minutes: number) =>
      new cloudwatch.Metric({ namespace: "Dilaya/SqliteData", metricName, dimensionsMap, statistic, period: cdk.Duration.minutes(minutes) });
    const alarms = [
      new cloudwatch.Alarm(stack, `ReplicationLagAlarm${suffix}`, {
        alarmName: `${name}-replication-lag`,
        alarmDescription: `Dilaya SQLite Data API cell ${cellId}: at least one database has not reached S3 for ${lagSeconds} s while litestream is running — its recent writes would not survive a crash`,
        metric: metric("ReplicationLagMaxSeconds", "Maximum", 1),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: lagSeconds,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    if (severalCells) {
      alarms.push(
        new cloudwatch.Alarm(stack, `MoveStuckAlarm${suffix}`, {
          alarmName: `${name}-move-stuck`,
          alarmDescription: `Dilaya SQLite Data API cell ${cellId}: a database move naming this cell has not ended after several sweeps — that app is served by nobody (read the _placement row that still carries a phase)`,
          metric: metric("MovesStuck", "Maximum", 1),
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          threshold: 1,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
        new cloudwatch.Alarm(stack, `RelayFailuresAlarm${suffix}`, {
          alarmName: `${name}-relay-failures`,
          alarmDescription: `Dilaya SQLite Data API cell ${cellId}: requests relayed to another cell keep failing — a peer is unreachable on the private network while still listed as serving`,
          metric: metric("RelayFailures", "Sum", 5),
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          threshold: 20,
          evaluationPeriods: 2,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    }
    for (const alarm of alarms) {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }
  }
}
