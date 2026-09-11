import * as cdk from "aws-cdk-lib";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { StackContext } from "./context.ts";
import { input } from "./inputs.ts";

export function createAsg(stack: cdk.Stack, ctx: StackContext): void {
  // Still a singleton (one instance at a time — no litestream dual-writer),
  // but replacements may land in EITHER public subnet and on either size.
  // Purchasing default is ON-DEMAND: observed reality (eu-west-1, t4g) is
  // that Spot can be unfulfillable across AZs and sizes for extended periods,
  // which turns the spec's ~2-min recovery into an open-ended outage. Spot
  // remains an explicit opt-in via spotPercentage (0-100).
  const spotPercentage = Math.min(100, Math.max(0, Number(input("spotPercentage", "0")) || 0));
  const asg = new autoscaling.AutoScalingGroup(stack, "Asg", {
    vpc: ctx.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    mixedInstancesPolicy: {
      launchTemplate: ctx.launchTemplate,
      launchTemplateOverrides: [
        { instanceType: new ec2.InstanceType(ctx.instanceType) },
        { instanceType: new ec2.InstanceType(input("fallbackInstanceType", "t4g.small")) },
      ],
      instancesDistribution: {
        onDemandPercentageAboveBaseCapacity: 100 - spotPercentage,
        spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
      },
    },
    minCapacity: 1,
    maxCapacity: 1,
    // Rolling update with minInstancesInService=0 = TERMINATE-BEFORE-LAUNCH:
    // CloudFormation kills the old instance, then brings up the new one — the
    // same sequence as the tested kill-instance recovery (~1 min gap), and the
    // only order compatible with the litestream single-writer invariant. Do
    // NOT switch back to replacingUpdate(): it runs old and new side by side.
    // What rolls the instance is therefore, by design, exactly two deliberate
    // changes: a new SERVICE (the source hash in user-data) and a bumped AMI
    // pin. Ordinary deploys leave the databases alone.
    updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
      maxBatchSize: 1,
      minInstancesInService: 0,
      pauseTime: cdk.Duration.seconds(0),
      waitOnResourceSignals: false,
    }),
    groupMetrics: [autoscaling.GroupMetrics.all()],
  });
  ctx.asg = asg;
  // Capacity rebalance must stay OFF: it launches the replacement while the
  // old instance is alive → two litestream writers on one generation path.
  (asg.node.defaultChild as autoscaling.CfnAutoScalingGroup).capacityRebalance = false;
}
