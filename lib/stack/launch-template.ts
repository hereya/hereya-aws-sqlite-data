import type * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { PINNED_AMI_ID } from "../ami-pin.ts";
import type { StackContext } from "./context.ts";
import { input } from "./inputs.ts";
import { resolveMachineImage } from "./machine-image.ts";

export function createLaunchTemplate(stack: cdk.Stack, ctx: StackContext): void {
  // Root volume size. Until 2026-08-25 this was not set AT ALL: the launch
  // template carried no blockDevices, so the ASG silently inherited the AMI's
  // own 8 GB root — a number nobody chose, running in production for four
  // months. Same class of problem as the AMI before it was pinned (invariant
  // 12): a value we were SUBJECT TO rather than one we own. Left implicit, a
  // future AMI bump could change the disk size on its own.
  //
  // The default comes from the sizing law measured in t_7f06618a3f17:
  //   disk needed ~= 3x total database bytes + ~2.3 GB of OS
  // Today that is 726 MB of databases -> 4.5 GB, which the old 8 GB did hold;
  // 30 GB buys roughly an order of magnitude of growth for ~2 USD/month.
  //
  // ⚠ Changing this rolls the instance (new launch template version, ~60 s
  // with no Data API) — which is also what APPLIES the new size. Nothing to
  // do on the box: cloud-init runs `growpart` and the root is XFS, so the
  // partition and filesystem extend themselves on the next boot.
  const rootVolumeGb = Number(input("rootVolumeGb", "30"));
  if (!Number.isInteger(rootVolumeGb) || rootVolumeGb < 8 || rootVolumeGb > 16384) {
    throw new Error(
      `invalid rootVolumeGb: ${input("rootVolumeGb", "30")} (expected a whole number of GB, 8..16384)`,
    );
  }

  ctx.launchTemplate = new ec2.LaunchTemplate(stack, "LaunchTemplate", {
    machineImage: resolveMachineImage(stack, input("amiId", PINNED_AMI_ID).trim()),
    instanceType: new ec2.InstanceType(ctx.instanceType),
    role: ctx.role,
    securityGroup: ctx.instanceSg,
    userData: ctx.userData,
    requireImdsv2: true,
    associatePublicIpAddress: true,
    // The device name MUST be the AMI's own root device (`/dev/xvda` on
    // AL2023 arm64) — any other name ADDS a second volume instead of resizing
    // the root, which would look like it worked while the databases stayed on
    // the same 8 GB.
    //
    // Size and encryption are stated; IOPS and throughput are left to the
    // snapshot's own values (3000 / 125).
    //
    // ENCRYPTED AT REST since 2026-08-25. This volume carries the `app.db` of
    // every app of every org, and it was the asymmetry that made the gap
    // obvious: the S3 replica has always been encrypted (`S3_MANAGED`, the
    // ReplicaBucket above), so the travelling COPY of customer data was
    // protected while the original was not.
    //
    // The key is the account's AWS-managed `aws/ebs`, reached by leaving
    // `kmsKey` unset — and that choice is load-bearing, not laziness. Its key
    // policy grants Encrypt/GenerateDataKey/CreateGrant to EVERY principal in
    // the account acting `ViaService: ec2.<region>.amazonaws.com`, which is
    // what lets the Auto Scaling service-linked role launch from it with no
    // extra grant. A CUSTOMER-MANAGED key would need that grant written
    // explicitly, and getting it wrong does not degrade anything — the ASG
    // simply cannot launch, which on this singleton is a total outage of
    // every org's databases. So no CMK parameter is offered here on purpose.
    //
    // Verified before shipping (2026-08-25): a throwaway t4g.micro launched
    // from this very pinned AMI with an encrypted 30 GB root reached
    // `running`, proving the snapshot -> encrypted-root conversion works in
    // this account and region. Encryption-by-default is OFF account-wide, and
    // no encrypted volume had ever existed here, so nothing about this path
    // could be assumed from prior art.
    blockDevices: [
      {
        deviceName: "/dev/xvda",
        volume: ec2.BlockDeviceVolume.ebs(rootVolumeGb, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      },
    ],
    // Spot-ness lives in the ASG's MixedInstancesPolicy below (a launch
    // template with InstanceMarketOptions conflicts with mixed instances).
    // no keyPair: SSM Session Manager only (spec §3)
  });
}
