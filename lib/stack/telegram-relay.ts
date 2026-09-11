import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import { join } from "node:path";
import type { StackContext } from "./context.ts";
import { input } from "./inputs.ts";

export function createTelegramRelay(stack: cdk.Stack, ctx: StackContext): void {
  // Telegram relay is wired only when the package inputs are provided; the
  // alarms exist regardless (visible in CloudWatch, other subscribers possible).
  const telegramTokenParam = input("telegramBotTokenParam", "");
  const telegramChatId = input("telegramChatId", "");
  if (telegramTokenParam !== "" && telegramChatId !== "") {
    const relay = new lambda.Function(stack, "HeartbeatRelay", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(join(ctx.repoRoot, "lib", "heartbeat-relay")),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        TELEGRAM_TOKEN_PARAM: telegramTokenParam,
        TELEGRAM_CHAT_ID: telegramChatId,
      },
    });
    relay.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Arn.format(
            { service: "ssm", resource: "parameter", resourceName: telegramTokenParam.replace(/^\//, "") },
            stack,
          ),
        ],
      }),
    );
    ctx.alertTopic.addSubscription(new snsSubs.LambdaSubscription(relay));
  }
}
