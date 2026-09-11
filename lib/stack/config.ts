import * as cdk from "aws-cdk-lib";
import type { StackContext } from "./context.ts";
import { input } from "./inputs.ts";

export function readStackConfig(_stack: cdk.Stack, ctx: StackContext): void {
  ctx.autoDelete = input("autoDelete", "false") === "true";
  ctx.instanceType = input("instanceType", "t4g.micro");
  ctx.servicePort = Number(input("servicePort", "8080"));
  ctx.removalPolicy = ctx.autoDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
}
