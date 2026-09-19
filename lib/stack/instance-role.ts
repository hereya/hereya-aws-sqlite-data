import type * as cdk from "aws-cdk-lib";
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
}
