import type * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { StackContext } from "./context.ts";

export function createStorage(stack: cdk.Stack, ctx: StackContext): void {
  // --- S3: durable source of truth ----------------------------------------
  // NO lifecycle rules and NO versioning — Litestream owns retention (spec §3);
  // an independent S3 rule can break its generation chain.
  ctx.bucket = new s3.Bucket(stack, "ReplicaBucket", {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: false,
    removalPolicy: ctx.removalPolicy,
    autoDeleteObjects: ctx.autoDelete,
  });

  // --- DynamoDB: org/app registry (runtime app lifecycle, spec §7) --------
  // PK org_id, SK sk: 'org' | 'app#<appId>' | 'name#<name>'
  ctx.table = new dynamodb.Table(stack, "RegistryTable", {
    partitionKey: { name: "org_id", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: ctx.removalPolicy,
  });
}
