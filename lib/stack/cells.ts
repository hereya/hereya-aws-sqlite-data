import type * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { buildAsg } from "./asg.ts";
import type { StackContext } from "./context.ts";
import { input } from "./inputs.ts";
import { buildCellUserData } from "./instance-user-data.ts";
import { buildLaunchTemplate } from "./launch-template.ts";

/**
 * How many cells this stack runs (t_dbmove_p3_relay_cells). 1 = the origin
 * alone, which is the stack exactly as it was: no resource below is created.
 */
export function readVmCount(): number {
  const raw = input("vmCount", "1");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new Error(`invalid vmCount: ${raw} (expected a whole number of cells, 1..8)`);
  }
  return n;
}

/**
 * The cells beyond the origin. A cell = its own launch template (only CELL_ID
 * differs) and its own ASG — its own, because everything the handover relies on
 * is scoped by group: the rolling update, the launch hook, and `overlap.ts`,
 * which reads every OTHER instance of its group as "my predecessor".
 *
 * What the cells SHARE is the point: one gateway, one Cloud Map service, one
 * security group, one role, one table and one bucket. Clients keep one URL and
 * one IAM grant; a request lands on any cell and the VM→VM relay
 * (service/src/relay.ts) takes it to the one that holds the app.
 *
 * ⚠️ Lowering vmCount DESTROYS the cells above it, instances included. Their
 * databases survive in S3, but nothing re-places them: move every app off a
 * cell (and delete its placement rows) BEFORE removing it.
 */
export function createExtraCells(stack: cdk.Stack, ctx: StackContext): void {
  ctx.extraCells = [];
  const vmCount = readVmCount();
  if (vmCount === 1) return;

  // The relay's path. Until now the instance SG admitted the VPC Link alone.
  ctx.instanceSg.addIngressRule(ctx.instanceSg, ec2.Port.tcp(ctx.servicePort), "VM to VM relay between cells");

  for (let i = 1; i < vmCount; i += 1) {
    const cellId = String(i);
    const userData = buildCellUserData(stack, ctx, cellId);
    const launchTemplate = buildLaunchTemplate(stack, ctx, `LaunchTemplateCell${cellId}`, userData);
    ctx.extraCells.push({ cellId, asg: buildAsg(stack, ctx, `AsgCell${cellId}`, launchTemplate) });
  }
}
