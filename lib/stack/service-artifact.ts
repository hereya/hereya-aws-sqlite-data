import * as cdk from "aws-cdk-lib";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { execSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { serviceContentHash } from "../service-hash.ts";
import type { StackContext } from "./context.ts";

export function createServiceArtifact(stack: cdk.Stack, ctx: StackContext): void {
  const repoRoot = ctx.repoRoot;

  // --- Service artifact ----------------------------------------------------
  const artifact = new s3assets.Asset(stack, "ServiceArtifact", {
    path: join(repoRoot, "service"),
    // Hash the service's INPUTS, never the built tarball. The hash rides in
    // the launch template, so it decides when CloudFormation replaces the
    // database VM — and `AssetHashType.OUTPUT` made that decision on a
    // tarball that is not reproducible (builtAt timestamp + tar/gzip mtimes),
    // so every deploy of anything rolled the databases for ~1 min. See
    // lib/service-hash.ts for the measurement.
    assetHash: serviceContentHash(repoRoot),
    assetHashType: cdk.AssetHashType.CUSTOM,
    bundling: {
      image: cdk.DockerImage.fromRegistry("public.ecr.aws/docker/library/node:24"),
      local: {
        tryBundle(outputDir: string): boolean {
          execSync(`node ${join(repoRoot, "scripts", "build-service.mjs")}`, { stdio: "inherit" });
          const built = join(repoRoot, "dist", "service.tar.gz");
          if (!existsSync(built)) throw new Error("build-service.mjs produced no artifact");
          cpSync(built, join(outputDir, "service.tar.gz"));
          return true;
        },
      },
    },
  });
  ctx.artifact = artifact;

  // The pointer parameter is what makes service-only updates possible without
  // CDK churn: upload a new tar.gz, update the parameter, restart the service.
  ctx.artifactParam = new ssm.StringParameter(stack, "ServiceArtifactParam", {
    parameterName: `/${stack.stackName}/service-artifact`,
    stringValue: artifact.s3ObjectUrl,
  });
}
