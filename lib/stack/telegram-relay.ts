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
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(join(ctx.repoRoot, "lib", "heartbeat-relay")),
      timeout: cdk.Duration.seconds(30),
      // 256, not 128: on nodejs24.x the sibling AlarmRelay peaked at 122 MB of 128 — an OOM here
      // drops the alert silently, since this relay IS the alert path (t_relay_mem_node24).
      memorySize: 256,
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
