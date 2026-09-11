import type * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { StackContext } from "./context.ts";

export function createNetwork(stack: cdk.Stack, ctx: StackContext): void {
  // --- Network: minimal VPC, public subnets, zero public ingress ----------
  // No NAT ($32/mo) and no interface endpoints (~$7/mo each): the instance
  // gets a public IP for outbound (SSM/CloudWatch are agent-initiated), and
  // the heavy S3/DDB traffic rides free gateway endpoints.
  const vpc = new ec2.Vpc(stack, "Vpc", {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
  });
  vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
  vpc.addGatewayEndpoint("DdbEndpoint", { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
  ctx.vpc = vpc;

  const instanceSg = new ec2.SecurityGroup(stack, "InstanceSg", {
    vpc,
    description: "Dilaya SQLite Data API instance - no public ingress; API GW VPC Link only",
    allowAllOutbound: true,
  });
  ctx.instanceSg = instanceSg;

  // --- Discovery + API Gateway (IAM/SigV4) ---------------------------------
  // Cloud Map + VPC Link v2 is the no-load-balancer private integration:
  // the singleton registers its own IP; API GW discovers it. The instance SG
  // only ever admits the VPC Link's SG on the service port.
  const vpcLinkSg = new ec2.SecurityGroup(stack, "VpcLinkSg", {
    vpc,
    description: "API Gateway VPC Link to Data API instance",
    allowAllOutbound: true,
  });
  instanceSg.addIngressRule(vpcLinkSg, ec2.Port.tcp(ctx.servicePort), "API GW VPC Link only");
  ctx.vpcLinkSg = vpcLinkSg;
}
