import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import type { StackContext } from "./context.ts";

export function createDiscovery(stack: cdk.Stack, ctx: StackContext): void {
  const namespace = new servicediscovery.PrivateDnsNamespace(stack, "Namespace", {
    name: `${stack.stackName}.dilaya.internal`.toLowerCase(),
    vpc: ctx.vpc,
  });
  // No Cloud Map health check: the deregister-all-then-register-self protocol
  // plus the ASG singleton guarantee at most one (live) registration.
  const discoveryService = namespace.createService("DataApiService", {
    dnsRecordType: servicediscovery.DnsRecordType.SRV,
    dnsTtl: cdk.Duration.seconds(10),
  });
  ctx.discoveryService = discoveryService;

  // Destroy caveat (runbook): Cloud Map refuses to delete a service that
  // still has registered instances, and the instance's self-registration
  // outlives it when the ASG tears down in parallel — leaving `cdk destroy`
  // DELETE_FAILED until someone deregisters by hand. This custom resource
  // depends on the service, so CloudFormation deletes it FIRST; its
  // on-delete deregisters whatever is still registered. Fail-open: on any
  // error the stack delete proceeds and, at worst, fails on the service
  // exactly like before (the manual runbook still applies).
  const deregisterFn = new lambda.Function(stack, "CloudMapDeregisterFn", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    timeout: cdk.Duration.minutes(2),
    description: "Deregisters lingering Cloud Map instances so stack deletion can remove the discovery service",
    code: lambda.Code.fromInline(`
const sd = require("@aws-sdk/client-servicediscovery");
const https = require("https");
function respond(event, status, reason) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      Status: status, Reason: reason || "ok",
      PhysicalResourceId: event.PhysicalResourceId || event.LogicalResourceId,
      StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId,
    });
    const u = new URL(event.ResponseURL);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "PUT",
        headers: { "content-type": "", "content-length": Buffer.byteLength(body) } },
      () => resolve());
    req.on("error", () => resolve());
    req.end(body);
  });
}
exports.handler = async (event) => {
  try {
    if (event.RequestType === "Delete") {
      const c = new sd.ServiceDiscoveryClient({});
      const serviceId = event.ResourceProperties.ServiceId;
      const list = await c.send(new sd.ListInstancesCommand({ ServiceId: serviceId }));
      const ops = [];
      for (const inst of (list.Instances || [])) {
        const r = await c.send(new sd.DeregisterInstanceCommand({ ServiceId: serviceId, InstanceId: inst.Id }));
        if (r.OperationId) ops.push(r.OperationId);
      }
      const deadline = Date.now() + 90000;
      for (const id of ops) {
        while (Date.now() < deadline) {
          const op = await c.send(new sd.GetOperationCommand({ OperationId: id }));
          const s = op.Operation && op.Operation.Status;
          if (s === "SUCCESS" || s === "FAIL") break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      console.log("deregistered " + ops.length + " instance(s) from " + serviceId);
    }
    await respond(event, "SUCCESS");
  } catch (e) {
    console.log("deregister-on-delete error (failing open): " + (e && e.message));
    await respond(event, "SUCCESS", String(e && e.message));
  }
};
`),
  });
  deregisterFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["servicediscovery:ListInstances", "servicediscovery:DeregisterInstance"],
      resources: [discoveryService.serviceArn],
    }),
  );
  deregisterFn.addToRolePolicy(
    new iam.PolicyStatement({
      // operations are not service-scoped resources
      actions: ["servicediscovery:GetOperation"],
      resources: ["*"],
    }),
  );
  const deregisterOnDelete = new cdk.CustomResource(stack, "CloudMapDeregisterOnDelete", {
    serviceToken: deregisterFn.functionArn,
    resourceType: "Custom::CloudMapDeregister",
    properties: { ServiceId: discoveryService.serviceId },
  });
  deregisterOnDelete.node.addDependency(discoveryService);
}
