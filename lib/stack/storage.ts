import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { StackContext } from "./context.ts";

/** Where the connector's purge archives a moved-away org's replicas (its purge/types.ts). */
export const ARCHIVE_PREFIX = "_archive/orgpurge/";
/** Jonatan, 29/10: the archive is kept 30 days. The connector refuses to purge unless the rule says exactly this. */
export const ARCHIVE_EXPIRY_DAYS = 30;

export function createStorage(stack: cdk.Stack, ctx: StackContext): void {
  // --- S3: durable source of truth ----------------------------------------
  // NO versioning, and NO lifecycle rule on any replica path — Litestream owns
  // retention (spec §3); an independent S3 rule can break its generation chain.
  // The ONE rule is outside every replica path: ARCHIVE_PREFIX, where the
  // connector's org-move PURGE (dilaya-connector src/region-migrate/purge/,
  // t_rca_p2_migrate lot 5c) copies a moved-away org's replicas before deleting
  // them — kept 30 days after the copy, then expired. Litestream writes only
  // under `<org>/<app>/app.db/` and org ids are UUIDs: no replica key can start
  // with `_`, so the rule can never reach a live chain.
  ctx.bucket = new s3.Bucket(stack, "ReplicaBucket", {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: false,
    lifecycleRules: [
      {
        id: "OrgPurgeArchiveExpiry",
        enabled: true,
        prefix: ARCHIVE_PREFIX,
        expiration: cdk.Duration.days(ARCHIVE_EXPIRY_DAYS),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      },
    ],
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
