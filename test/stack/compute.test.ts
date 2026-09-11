// The instance itself: launch template, ASG shape and update policy, and the
// root volume this stack owns rather than inherits.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Template } from "aws-cdk-lib/assertions";
import { buildTemplate } from "./helpers.ts";

let template: Template;

before(() => {
  template = buildTemplate();
});

test("launch template: no SSH key, IMDSv2 required", () => {
  const lts = template.findResources("AWS::EC2::LaunchTemplate");
  const lt = Object.values(lts)[0]!;
  const data = lt.Properties.LaunchTemplateData;
  assert.equal(data.KeyName, undefined, "SSM only — no SSH keypair");
  assert.equal(data.MetadataOptions?.HttpTokens, "required");
});

test("ASG: 1/1/1 singleton, all-Spot mixed instances, capacity rebalance OFF", () => {
  const asgs = template.findResources("AWS::AutoScaling::AutoScalingGroup");
  const asg = Object.values(asgs)[0]!;
  assert.equal(asg.Properties.MinSize, "1");
  assert.equal(asg.Properties.MaxSize, "1");
  assert.equal(asg.Properties.CapacityRebalance, false);
  const dist = asg.Properties.MixedInstancesPolicy.InstancesDistribution;
  assert.equal(dist.OnDemandPercentageAboveBaseCapacity, 100, "on-demand by default (Spot is opt-in)");
  assert.equal(dist.SpotAllocationStrategy, "capacity-optimized");
  const overrides = asg.Properties.MixedInstancesPolicy.LaunchTemplate.Overrides;
  assert.ok(overrides.length >= 2, "at least two instance-type fallbacks");
  // replacements must be able to land in more than one AZ
  assert.ok((asg.Properties.VPCZoneIdentifier ?? []).length >= 2, "ASG must span >=2 subnets");
});

test("ASG update policy: rolling update, terminate-before-launch (single litestream writer)", () => {
  const asgs = template.findResources("AWS::AutoScaling::AutoScalingGroup");
  const asg = Object.values(asgs)[0]!;
  const rolling = asg.UpdatePolicy?.AutoScalingRollingUpdate;
  assert.ok(rolling, "must use AutoScalingRollingUpdate (replacingUpdate runs old+new side by side)");
  assert.equal(rolling.MinInstancesInService, 0, "old instance must terminate BEFORE the new one launches");
  assert.equal(rolling.MaxBatchSize, 1);
  assert.equal(asg.UpdatePolicy?.AutoScalingReplacingUpdate, undefined);
});

test("user-data embeds the service artifact hash (deploy rolls the instance)", () => {
  const lts = template.findResources("AWS::EC2::LaunchTemplate");
  const lt = Object.values(lts)[0]!;
  const userData = JSON.stringify(lt.Properties.LaunchTemplateData.UserData);
  assert.ok(userData.includes("service-artifact-hash:"), "artifact hash line must be in user-data");
});

test("the root volume size is OURS, not the AMI's default", () => {
  // Until 2026-08-25 the launch template carried no blockDevices at all, so the
  // ASG inherited the AMI's 8 GB root — a number nobody chose, live for four
  // months. The device name is the load-bearing half: any name other than the
  // AMI's own root device ADDS a second volume instead of resizing the root,
  // which looks like it worked while the databases stay on the same 8 GB.
  template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
    LaunchTemplateData: {
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/xvda",
          Ebs: { VolumeSize: 30, VolumeType: "gp3", DeleteOnTermination: true },
        },
      ],
    },
  });
});

test("the root volume is encrypted at rest", () => {
  // This disk carries the app.db of every app of every org. The S3 replica has
  // always been encrypted, so until 2026-08-25 the travelling COPY of customer
  // data was protected while the original was not.
  const lt = Object.values(template.findResources("AWS::EC2::LaunchTemplate"))[0];
  assert.ok(lt, "the launch template must exist");
  const ebs = lt.Properties.LaunchTemplateData.BlockDeviceMappings[0].Ebs;
  assert.equal(ebs.Encrypted, true, "the databases' own disk must be encrypted at rest");
});

test("encryption uses the AWS-managed key — no customer-managed key is wired in", () => {
  // Load-bearing, not laziness. `aws/ebs` grants use to every principal in the
  // account acting via EC2, which is what lets the Auto Scaling service-linked
  // role launch from it with no explicit grant. A CMK needs that grant written
  // by hand, and getting it wrong does not degrade anything — the ASG simply
  // cannot launch, which on this singleton is a total outage of every org's
  // databases. If a CMK is ever wanted, this test should fail first.
  const lt = Object.values(template.findResources("AWS::EC2::LaunchTemplate"))[0];
  assert.ok(lt, "the launch template must exist");
  const ebs = lt.Properties.LaunchTemplateData.BlockDeviceMappings[0].Ebs;
  assert.equal(ebs.KmsKeyId, undefined, "leaving KmsKeyId unset is what selects aws/ebs");
  assert.equal(ebs.Iops, undefined, "IOPS is left to the snapshot's own value");
  assert.equal(ebs.Throughput, undefined, "throughput is left to the snapshot's own value");
});
