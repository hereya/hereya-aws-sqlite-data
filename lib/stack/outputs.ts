import * as cdk from "aws-cdk-lib";
import type { StackContext } from "./context.ts";

export function createOutputs(stack: cdk.Stack, ctx: StackContext): void {
  const { bucket, table, httpApi, capabilitySecret } = ctx;

  // --- Package outputs (consumer env contract) -----------------------------
  new cdk.CfnOutput(stack, "awsRegion", { value: stack.region });
  new cdk.CfnOutput(stack, "sqliteReplicaBucketName", { value: bucket.bucketName });
  new cdk.CfnOutput(stack, "registryTableName", { value: table.tableName });
  new cdk.CfnOutput(stack, "iamPolicySqliteRegistry", {
    value: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            // Scan: the connector's layer-sync sweep enumerates deployed
            // backends across ALL orgs (app# rows with lambdaFunctionName).
            "dynamodb:Scan",
          ],
          Resource: [table.tableArn],
        },
      ],
    }),
  });
  new cdk.CfnOutput(stack, "dataApiUrl", { value: httpApi.apiEndpoint });
  new cdk.CfnOutput(stack, "iamPolicySqliteDataApi", {
    value: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["execute-api:Invoke"],
          Resource: [
            `arn:aws:execute-api:${stack.region}:${stack.account}:${httpApi.apiId}/*/*/*`,
          ],
        },
      ],
    }),
  });
  // The connector reads this secret to mint capability tokens; the iamPolicy*
  // output auto-attaches secretsmanager:GetSecretValue to the connector's role
  // (mirrors iamPolicySqliteRegistry / iamPolicySqliteDataApi wiring).
  new cdk.CfnOutput(stack, "capabilitySecretArn", { value: capabilitySecret.secretArn });
  new cdk.CfnOutput(stack, "iamPolicySqliteCapability", {
    value: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [capabilitySecret.secretArn],
        },
      ],
    }),
  });
}
