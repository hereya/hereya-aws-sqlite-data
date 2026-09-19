// The launch lifecycle hook: what makes "launch before terminate" mean "launch,
// WARM UP, then terminate" (t_vm_zero_cut_handover).
//
// Overlapping instances is not enough on its own. CloudFormation's rolling
// update terminates the old instance as soon as the new one is InService, and
// for the ASG "InService" means the EC2 instance is running — some 45 s before
// this service has restored anything. Without the hook the old instance would
// be killed while the new one is still booting, and the cut would be as long
// as it is today, only with two machines to pay for.
//
// So, with the handover on, the stack puts a hook on EC2_INSTANCE_LAUNCHING: the
// new instance sits in `Pending:Wait`, invisible to the rolling update, until
// this service says it is warm. Only then does the old one receive its SIGTERM.
//
// The hook's DEFAULT RESULT is ABANDON, and that is a feature: a build that
// cannot boot never completes the action, the ASG discards it after the
// heartbeat timeout, and the old instance — never told to stop — keeps serving.
// Before this, a service that failed to boot took production down with it.
import {
  AutoScalingClient,
  CompleteLifecycleActionCommand,
  DescribeAutoScalingInstancesCommand,
} from "@aws-sdk/client-auto-scaling";

/** Must match the hook the stack creates (lib/stack/asg.ts). */
export const LAUNCH_HOOK_NAME = "dilaya-warm-before-service";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "handover", ...event }));
}

export interface LifecycleDeps {
  client: Pick<AutoScalingClient, "send">;
}

export function createLifecycleClient(region: string): AutoScalingClient {
  return new AutoScalingClient({ region });
}

/**
 * Tell the ASG this instance is warm. Best-effort and never throws: if it
 * fails, the hook's heartbeat timeout abandons the instance and the ASG tries
 * again with a fresh one — slower, and nothing is served from a half-state.
 *
 * It asks for its own state first because a launch hook is only pending on a
 * LAUNCH: after a plain process restart (systemd) the instance is already
 * InService and completing would be an error worth not logging as one.
 */
export async function completeLaunchHook(deps: LifecycleDeps, instanceId: string): Promise<boolean> {
  if (!instanceId) return false;
  try {
    const res = await deps.client.send(new DescribeAutoScalingInstancesCommand({ InstanceIds: [instanceId] }));
    const self = res.AutoScalingInstances?.[0];
    if (!self?.AutoScalingGroupName || self.LifecycleState !== "Pending:Wait") {
      log({ event: "launch-hook-skipped", state: self?.LifecycleState ?? "unknown" });
      return false;
    }
    await deps.client.send(
      new CompleteLifecycleActionCommand({
        AutoScalingGroupName: self.AutoScalingGroupName,
        LifecycleHookName: LAUNCH_HOOK_NAME,
        InstanceId: instanceId,
        LifecycleActionResult: "CONTINUE",
      }),
    );
    log({ event: "launch-hook-completed", asg: self.AutoScalingGroupName });
    return true;
  } catch (err) {
    console.error(JSON.stringify({ type: "handover", event: "launch-hook-failed", message: (err as Error).message }));
    return false;
  }
}
