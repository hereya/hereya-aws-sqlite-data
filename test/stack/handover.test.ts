// The overlap is ONE switch with the protocol (t_vm_zero_cut_handover).
//
// `handoverEnabled` flips the service's protocol AND the ASG's shape together,
// because either half alone is harmful: instances overlapping without the
// protocol are two litestream writers (invariant 5); the protocol without the
// overlap is a wait nobody answers. What is pinned here is that the template
// cannot express one without the other — and that OFF is byte-for-byte the
// singleton it has always been, since OFF is what production runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTemplate } from "./helpers.ts";

function withHandover<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.handoverEnabled;
  if (value === undefined) delete process.env.handoverEnabled;
  else process.env.handoverEnabled = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.handoverEnabled;
    else process.env.handoverEnabled = before;
  }
}

function asgOf(template: ReturnType<typeof buildTemplate>) {
  const [asg] = Object.values(template.findResources("AWS::AutoScaling::AutoScalingGroup"));
  return asg as { Properties: Record<string, unknown>; UpdatePolicy: { AutoScalingRollingUpdate: Record<string, unknown> } };
}

test("OFF (the default, and production): terminate-before-launch, no second slot, no hook", () => {
  const template = withHandover(undefined, buildTemplate);
  const asg = asgOf(template);
  assert.equal(asg.Properties.MaxSize, "1");
  assert.equal(asg.UpdatePolicy.AutoScalingRollingUpdate.MinInstancesInService, 0);
  assert.equal(asg.Properties.DesiredCapacity, undefined, "OFF must not change the template production already runs");
  assert.equal(asg.Properties.LifecycleHookSpecificationList, undefined);
});

test("ON: launch-before-terminate, held back by a launch hook that ABANDONS a build which never warms", () => {
  const template = withHandover("true", buildTemplate);
  const asg = asgOf(template);
  assert.equal(asg.Properties.MaxSize, "2", "the rolling update needs a second slot to launch into");
  assert.equal(asg.Properties.MinSize, "1");
  assert.equal(asg.Properties.DesiredCapacity, "1", "the second slot is for a roll, never for a second serving instance");
  assert.equal(asg.UpdatePolicy.AutoScalingRollingUpdate.MinInstancesInService, 1);
  assert.equal(asg.Properties.CapacityRebalance, false, "capacity rebalance stays OFF either way");
  // INLINE, never a separate AWS::AutoScaling::LifecycleHook: that resource is
  // created after the ASG's own update, i.e. after the roll it must hold back.
  template.resourceCountIs("AWS::AutoScaling::LifecycleHook", 0);
  assert.deepEqual(asg.Properties.LifecycleHookSpecificationList, [
    {
      // The name is a contract with service/src/handover/lifecycle.ts.
      LifecycleHookName: "dilaya-warm-before-service",
      LifecycleTransition: "autoscaling:EC2_INSTANCE_LAUNCHING",
      // CONTINUE would put a build that cannot boot InService, and the rolling
      // update would then kill the healthy instance for it.
      DefaultResult: "ABANDON",
      HeartbeatTimeout: 600,
    },
  ]);
});

test("ON reaches the service too — the same switch, not a sibling", () => {
  const on = JSON.stringify(withHandover("true", buildTemplate).toJSON());
  const off = JSON.stringify(withHandover(undefined, buildTemplate).toJSON());
  assert.match(on, /HANDOVER_ENABLED=true/);
  assert.match(off, /HANDOVER_ENABLED=false/);
});

test("the instance may release ITS OWN stack's hook, and nothing wider", () => {
  const template = withHandover("true", buildTemplate);
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement,
  );
  const hook = statements.find((s) => s.Sid === "HandoverLaunchHook");
  assert.ok(hook, "the role must be able to complete the launch hook, or every launch is abandoned");
  assert.deepEqual(hook.Action, "autoscaling:CompleteLifecycleAction");
  assert.match(JSON.stringify(hook.Resource), /autoScalingGroupName\/.*AWS::StackName/, "scoped to this stack's ASG");
});
