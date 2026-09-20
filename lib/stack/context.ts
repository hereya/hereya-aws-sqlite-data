import type * as cdk from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as s3assets from "aws-cdk-lib/aws-s3-assets";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import type * as sns from "aws-cdk-lib/aws-sns";
import type * as ssm from "aws-cdk-lib/aws-ssm";

/**
 * Everything the stack's build steps hand to each other.
 *
 * This replaces what used to be ~800 lines of local variables in one
 * constructor: each step reads what it needs off this object and writes back
 * what later steps need. The steps run in a fixed order (see
 * `hereya-aws-sqlite-data-stack.ts`), and that order is the contract — a field
 * is only readable once the step that sets it has run.
 *
 * Order matters for more than availability: IAM statements are appended to the
 * instance role in call order, so moving a step moves the synthesized policy
 * document. `scripts/synth-golden.ts` is what proves a change here left the
 * template intact — neither `tsc` nor a green `cdk synth` can see that drift.
 */
export interface StackContext {
  // --- config (set by readStackConfig; repoRoot is passed in by the stack
  // file itself, which is the only place whose depth `import.meta.url` may be
  // resolved against) ---
  repoRoot: string;
  autoDelete: boolean;
  instanceType: string;
  servicePort: number;
  removalPolicy: cdk.RemovalPolicy;

  // --- storage ---
  bucket: s3.Bucket;
  table: dynamodb.Table;

  // --- network ---
  vpc: ec2.Vpc;
  instanceSg: ec2.SecurityGroup;
  vpcLinkSg: ec2.SecurityGroup;

  // --- discovery + gateway ---
  discoveryService: servicediscovery.Service;
  vpcLink: apigwv2.VpcLink;
  httpApi: apigwv2.HttpApi;

  // --- service artifact ---
  artifact: s3assets.Asset;
  artifactParam: ssm.StringParameter;

  // --- instance ---
  role: iam.Role;
  capabilitySecret: secretsmanager.Secret;
  userData: ec2.UserData;
  launchTemplate: ec2.LaunchTemplate;
  asg: autoscaling.AutoScalingGroup;
  /** The cells BEYOND the origin (cells.ts). Empty unless `vmCount` > 1. */
  extraCells: { cellId: string; asg: autoscaling.AutoScalingGroup }[];

  // --- alarms ---
  alertTopic: sns.Topic;
}

/**
 * The context before any step has run. Fields are filled in by the steps, in
 * the order the stack file calls them.
 */
export function emptyContext(repoRoot: string): StackContext {
  return { repoRoot } as StackContext;
}
