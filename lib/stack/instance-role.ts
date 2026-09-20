import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context.ts";

export function createInstanceRole(stack: cdk.Stack, ctx: StackContext): void {
  const { bucket, table, artifact, artifactParam, discoveryService } = ctx;

  // --- Instance role: least privilege --------------------------------------
  const role = new iam.Role(stack, "InstanceRole", {
    assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
  });
  ctx.role = role;
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "LitestreamReplicaAccess",
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      resources: [bucket.arnForObjects("*")],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "LitestreamReplicaList",
      // GetBucketLocation: litestream resolves the bucket region before restore
      actions: ["s3:ListBucket", "s3:GetBucketLocation"],
      resources: [bucket.bucketArn],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "RegistryRead",
      actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"],
      resources: [table.tableArn],
    }),
  );
  // Per-app write recency (service/src/write-stats.ts). WRITE access is
  // granted, but ONLY into the fixed `_writestats` partition — the condition
  // is on the partition key itself, so this role still cannot touch a single
  // org or app row. That matters: the registry is the source of truth the
  // double control reads, and the data plane has no business writing to it.
  // The handover records (service/src/handover/, t_vm_zero_cut_handover).
  // Same shape and same reasoning as WriteStats below: PutItem, and ONLY into
  // the fixed `_handover` partition, so this role still cannot write a single
  // org or app row.
  //
  // ⚠️ It is PutItem, not UpdateItem, and that distinction cost a live trial:
  // the handover writes whole records, the WriteStats grant covers UpdateItem
  // alone, and the service SWALLOWS the failure by design (a dying instance
  // must still die cleanly). So a missing grant here does not raise — it makes
  // the whole feature a silent no-op. Found 2026-09-19 on a throwaway stack,
  // verbatim: "is not authorized to perform: dynamodb:PutItem".
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "HandoverRecords",
      actions: ["dynamodb:PutItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["_handover"] },
      },
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "WriteStats",
      actions: ["dynamodb:UpdateItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["_writestats"] },
      },
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "Heartbeat",
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: { StringEquals: { "cloudwatch:namespace": "Dilaya/SqliteData" } },
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "ArtifactPointer",
      actions: ["ssm:GetParameter"],
      resources: [artifactParam.parameterArn],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "CloudMapSelfRegistration",
      actions: [
        "servicediscovery:RegisterInstance",
        "servicediscovery:DeregisterInstance",
        "servicediscovery:ListInstances",
      ],
      resources: [discoveryService.serviceArn],
    }),
  );
  // Cloud Map manages the Route53 records of the private DNS namespace on the
  // caller's behalf during (de)registration (cf. AWSCloudMapRegisterInstanceAccess).
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "CloudMapRoute53",
      actions: ["route53:ChangeResourceRecordSets", "route53:GetHostedZone"],
      resources: ["arn:aws:route53:::hostedzone/*"],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "CloudMapRoute53List",
      actions: ["route53:ListHostedZonesByName"],
      resources: ["*"],
    }),
  );
  artifact.grantRead(role);
  // Release of the launch hook (handover only). The ASG is named by
  // CloudFormation as `<stack>-Asg…`, and the ARN is written as a pattern
  // rather than taken from the resource: the ASG depends on this role through
  // the launch template, so referencing it here would be a cycle.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "HandoverLaunchHook",
      actions: ["autoscaling:CompleteLifecycleAction"],
      resources: [
        `arn:aws:autoscaling:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:autoScalingGroup:*:autoScalingGroupName/${cdk.Aws.STACK_NAME}-*`,
      ],
    }),
  );
  // The VM directory (service/src/vms.ts): where each cell answers on the
  // private network, for the VM→VM relay. Same shape as the two grants above —
  // only the fixed `_vms` partition, never an org or app row. DeleteItem so a
  // cell can clear the rows its own past instances left behind.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "VmDirectory",
      actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["_vms"] },
      },
    }),
  );
  // Describe* has no resource-level scoping in Auto Scaling; read-only.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "HandoverDescribeSelf",
      actions: ["autoscaling:DescribeAutoScalingInstances"],
      resources: ["*"],
    }),
  );
}
