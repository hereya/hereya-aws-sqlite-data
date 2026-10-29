import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { StackContext } from "./context.ts";

/** Where the connector's purge archives a moved-away org's replicas (its purge/types.ts). */
export const ARCHIVE_PREFIX = "_archive/orgpurge/";
/** The archive is kept 30 days; the connector refuses to purge unless the rule says exactly this. */
export const ARCHIVE_EXPIRY_DAYS = 30;
/** The tag the purge puts on an archived original (S3 tag filters need a value: a fixed one). */
export const PURGE_TAG = { key: "dilaya-purge", value: "1" } as const;
/** A tagged object is expired this long after its creation. */
export const PURGE_TAG_EXPIRY_DAYS = 1;

export function createStorage(stack: cdk.Stack, ctx: StackContext): void {
  // --- S3: durable source of truth ----------------------------------------
  // NO versioning, and NO lifecycle rule on live replica paths — Litestream owns
  // retention (spec §3); an independent S3 rule can break its generation chain —
  // EXCEPT the purge tag rule. The connector's org-move purge
  // (dilaya-connector src/region-migrate/purge/) copies a purged org's replicas
  // to ARCHIVE_PREFIX (expired 30 days after the copy), then tags the originals
  // PURGE_TAG (expired 1 day after their creation). Litestream never tags an
  // object, so the tag rule only ever reaches what the purge marked.
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
      {
        id: "OrgPurgeTaggedExpiry",
        enabled: true,
        tagFilters: { [PURGE_TAG.key]: PURGE_TAG.value },
        expiration: cdk.Duration.days(PURGE_TAG_EXPIRY_DAYS),
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
