import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type { StackContext } from "../context.ts";
import { input } from "../inputs.ts";

export function createHeadroomAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const alertTopic = ctx.alertTopic;

  // Default 150 MB: on the default 916 MB instance that is roughly the point
  // where ~150 more databases would no longer fit, i.e. enough warning to
  // plan a bigger instance rather than discover the wall by hitting it.
  const memoryHeadroomBytes = Number(input("memoryHeadroomBytes", "157286400"));
  if (!Number.isFinite(memoryHeadroomBytes) || memoryHeadroomBytes <= 0) {
    throw new Error(`invalid memoryHeadroomBytes: ${input("memoryHeadroomBytes", "157286400")}`);
  }

  // Default 1.5 GiB. Measured on the production volume 2026-08-25: 8.5 GB
  // total, 4.14 GB free, 2.10 GB of it the database directory — the disk is
  // already HALF FULL, which is not what anyone would have guessed from the
  // size of the databases (726 MB of app.db across 61 apps). Growth is ~0.5
  // GB/month over the four months this VM has served customers, so 1.5 GiB of
  // headroom is roughly three months of warning: enough to grow the gp3
  // volume (an online operation) deliberately rather than at 3am.
  const diskHeadroomBytes = Number(input("diskHeadroomBytes", "1610612736"));
  if (!Number.isFinite(diskHeadroomBytes) || diskHeadroomBytes <= 0) {
    throw new Error(`invalid diskHeadroomBytes: ${input("diskHeadroomBytes", "1610612736")}`);
  }

  // Memory headroom. The two alarms above catch the VM being DEAD; this one
  // catches it running out of room to grow, which is the failure that
  // actually limits how many apps can be sold.
  //
  // Measured 2026-08-24 (scripts/loadtest.mjs, N = 20..1000):
  //   RSS ~= 65 MB baseline + 0.268 MB per database.
  // NB the first reading of this — 56.9 MB at 61 databases — was divided to
  // give "0.93 MB per database", which overstated the MARGINAL cost by ~3.4x:
  // most of that total is a baseline litestream pays once, not per database.
  // The ceiling on the default 916 MB instance is therefore around two
  // thousand apps rather than a few hundred — still far nearer than any cost
  // ceiling, which is why this alarm exists. Until it did, the number could
  // only be had by opening an SSM session and running `ps` by hand, which is
  // to say it was never had at all.
  //
  // NOT treatMissingData.BREACHING, unlike its neighbours: missing data here
  // means the heartbeat stopped, and the heartbeat alarm already says so
  // loudly. Making this one breach too would turn one incident into two
  // pages that say the same thing.
  const memoryAlarm = new cloudwatch.Alarm(stack, "MemoryHeadroomAlarm", {
    alarmName: `${stack.stackName}-memory-headroom`,
    alarmDescription:
      "Available memory on the Data API VM is low — litestream grows with the number of databases served, so this is the ceiling on how many apps this instance can hold",
    metric: new cloudwatch.Metric({
      namespace: "Dilaya/SqliteData",
      metricName: "MemoryAvailableBytes",
      dimensionsMap: { stack: stack.stackName },
      statistic: "Minimum",
      period: cdk.Duration.minutes(5),
    }),
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    threshold: memoryHeadroomBytes,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  memoryAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
  memoryAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

  // Disk headroom — the third resource, and the only one that cannot be
  // recovered by the machine itself.
  //
  // Eviction defends the other two: an idle app leaves the litestream config,
  // freeing a thread and ~0.46 MB of RSS. It deliberately does NOT delete the
  // file, so no eviction has ever returned a single byte of disk. Databases of
  // deleted customers are not removed either. Disk is therefore the one curve
  // that only goes up.
  //
  // What it looks like when it ends: `SQLITE_FULL` on the writes of EVERY org
  // at once — and until this metric existed, every other instrument stayed
  // green right up to that first error. The heartbeat beats (the process is
  // alive), memory is free, threads are fine, the Lambdas raise nothing while
  // nobody writes, CloudFront serves 200s. Same shape as the other findings of
  // this sweep: a layer no existing instrument could see, not an instrument
  // read badly.
  //
  // Measured 2026-08-25 on the production volume, and it is not what the
  // database sizes suggest: 2.10 GB in the database directory, of which only
  // 726 MB is the app.db files — the other 1.37 GB is litestream's local
  // staging directories (~1.9x the databases they replicate).
  //
  // NOT breaching on missing data, for the same reason as its memory twin:
  // silence means the heartbeat stopped, and that alarm already pages.
  const diskAlarm = new cloudwatch.Alarm(stack, "DiskHeadroomAlarm", {
    alarmName: `${stack.stackName}-disk-headroom`,
    alarmDescription:
      "Free space on the Data API VM is low — every org's writes fail together when this volume fills, and eviction never frees disk (an evicted app keeps its file), so this number only ever falls",
    metric: new cloudwatch.Metric({
      namespace: "Dilaya/SqliteData",
      metricName: "DiskAvailableBytes",
      dimensionsMap: { stack: stack.stackName },
      statistic: "Minimum",
      period: cdk.Duration.minutes(5),
    }),
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    threshold: diskHeadroomBytes,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  diskAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
  diskAlarm.addOkAction(new cwActions.SnsAction(alertTopic));
}
