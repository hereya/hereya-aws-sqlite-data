import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { execSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUserData } from "./user-data.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Hereya package inputs arrive as plain env vars (camelCase).
function input(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export class HereyaAwsSqliteDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const autoDelete = input("autoDelete", "false") === "true";
    const instanceType = input("instanceType", "t4g.micro");
    const servicePort = Number(input("servicePort", "8080"));
    const removalPolicy = autoDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // --- S3: durable source of truth ----------------------------------------
    // NO lifecycle rules and NO versioning — Litestream owns retention (spec §3);
    // an independent S3 rule can break its generation chain.
    const bucket = new s3.Bucket(this, "ReplicaBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy,
      autoDeleteObjects: autoDelete,
    });

    // --- DynamoDB: org/app registry (runtime app lifecycle, spec §7) --------
    // PK org_id, SK sk: 'org' | 'app#<appId>' | 'name#<name>'
    const table = new dynamodb.Table(this, "RegistryTable", {
      partitionKey: { name: "org_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // --- Network: minimal VPC, public subnets, zero public ingress ----------
    // No NAT ($32/mo) and no interface endpoints (~$7/mo each): the instance
    // gets a public IP for outbound (SSM/CloudWatch are agent-initiated), and
    // the heavy S3/DDB traffic rides free gateway endpoints.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
    });
    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    vpc.addGatewayEndpoint("DdbEndpoint", { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });

    const instanceSg = new ec2.SecurityGroup(this, "InstanceSg", {
      vpc,
      description: "Dilaya SQLite Data API instance — no public ingress; API GW VPC Link only",
      allowAllOutbound: true,
    });

    // --- Discovery + API Gateway (IAM/SigV4) ---------------------------------
    // Cloud Map + VPC Link v2 is the no-load-balancer private integration:
    // the singleton registers its own IP; API GW discovers it. The instance SG
    // only ever admits the VPC Link's SG on the service port.
    const vpcLinkSg = new ec2.SecurityGroup(this, "VpcLinkSg", {
      vpc,
      description: "API Gateway VPC Link → Data API instance",
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(vpcLinkSg, ec2.Port.tcp(servicePort), "API GW VPC Link only");

    const namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", {
      name: `${this.stackName}.dilaya.internal`.toLowerCase(),
      vpc,
    });
    // No Cloud Map health check: the deregister-all-then-register-self protocol
    // plus the ASG singleton guarantee at most one (live) registration.
    const discoveryService = namespace.createService("DataApiService", {
      dnsRecordType: servicediscovery.DnsRecordType.SRV,
      dnsTtl: cdk.Duration.seconds(10),
    });

    const vpcLink = new apigwv2.VpcLink(this, "VpcLink", {
      vpc,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [vpcLinkSg],
    });

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${this.stackName}-sqlite-data`,
      defaultAuthorizer: new HttpIamAuthorizer(),
    });
    const integration = new HttpServiceDiscoveryIntegration("DataApi", discoveryService, { vpcLink });
    for (const [method, path] of [
      [apigwv2.HttpMethod.POST, "/query"],
      [apigwv2.HttpMethod.POST, "/batch-execute"],
      [apigwv2.HttpMethod.POST, "/tx/begin"],
      [apigwv2.HttpMethod.POST, "/tx/commit"],
      [apigwv2.HttpMethod.POST, "/tx/rollback"],
      [apigwv2.HttpMethod.POST, "/admin/sync"],
      [apigwv2.HttpMethod.GET, "/health"],
    ] as const) {
      httpApi.addRoutes({ path, methods: [method], integration });
    }

    // --- Service artifact ----------------------------------------------------
    const artifact = new s3assets.Asset(this, "ServiceArtifact", {
      path: join(repoRoot, "service"),
      assetHashType: cdk.AssetHashType.OUTPUT,
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

    // The pointer parameter is what makes service-only updates possible without
    // CDK churn: upload a new tar.gz, update the parameter, restart the service.
    const artifactParam = new ssm.StringParameter(this, "ServiceArtifactParam", {
      parameterName: `/${this.stackName}/service-artifact`,
      stringValue: artifact.s3ObjectUrl,
    });

    // --- Instance role: least privilege --------------------------------------
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "LitestreamReplicaAccess",
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [bucket.arnForObjects("*")],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "LitestreamReplicaList",
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RegistryRead",
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"],
        resources: [table.tableArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Heartbeat",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "Dilaya/SqliteData" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ArtifactPointer",
        actions: ["ssm:GetParameter"],
        resources: [artifactParam.parameterArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudMapSelfRegistration",
        actions: [
          "servicediscovery:RegisterInstance",
          "servicediscovery:DeregisterInstance",
          "servicediscovery:ListInstances",
        ],
        resources: [discoveryService.serviceArn],
      }),
    );
    // Cloud Map manages the Route53 records of the private DNS namespace on the
    // caller's behalf during (de)registration (cf. AWSCloudMapRegisterInstanceAccess).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudMapRoute53",
        actions: ["route53:ChangeResourceRecordSets", "route53:GetHostedZone"],
        resources: ["arn:aws:route53:::hostedzone/*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudMapRoute53List",
        actions: ["route53:ListHostedZonesByName"],
        resources: ["*"],
      }),
    );
    artifact.grantRead(role);

    // --- Launch template + self-healing Spot singleton ----------------------
    const userData = ec2.UserData.custom(
      buildUserData({
        awsRegion: this.region,
        artifactParamName: artifactParam.parameterName,
        serviceEnv: {
          NODE_ENV: "production",
          PORT: String(servicePort),
          DB_DIR: "/var/lib/dilaya/dbs",
          AWS_REGION: this.region,
          REGISTRY_MODE: "ddb",
          REGISTRY_TABLE: table.tableName,
          REPLICA_BASE_URL: `s3://${bucket.bucketName}`,
          LITESTREAM_BIN: "/usr/local/bin/litestream",
          LITESTREAM_CONFIG_PATH: "/etc/dilaya/litestream.yml",
          SQL_TIMEOUT_MS: input("sqlTimeoutMs", "20000"),
          MAX_INFLIGHT_PER_APP: input("maxInflightPerApp", "16"),
          MAX_LIVE_WORKERS: input("maxLiveWorkers", "8"),
          REGISTRY_POLL_SECONDS: input("registryPollSeconds", "30"),
          LITESTREAM_SYNC_INTERVAL_MS: input("litestreamSyncIntervalMs", "1000"),
          LITESTREAM_RETENTION: input("litestreamRetention", "72h"),
          HEARTBEAT_ENABLED: "1",
          HEARTBEAT_DIMENSION: this.stackName,
          IMDS_ENABLED: "1",
          CLOUDMAP_SERVICE_ID: discoveryService.serviceId,
        },
      }),
    );

    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      instanceType: new ec2.InstanceType(instanceType),
      role,
      securityGroup: instanceSg,
      userData,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      // Spot: the workload tolerates interruption (ASG relaunches; Litestream
      // restores). ONE_TIME so the ASG — not the Spot request — owns replacement.
      spotOptions: { requestType: ec2.SpotRequestType.ONE_TIME },
      // no keyPair: SSM Session Manager only (spec §3)
    });

    const asg = new autoscaling.AutoScalingGroup(this, "Asg", {
      vpc,
      vpcSubnets: { subnets: [vpc.publicSubnets[0]!] }, // single AZ v1 (spec §3)
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      updatePolicy: autoscaling.UpdatePolicy.replacingUpdate(),
    });
    // Capacity rebalance must stay OFF: it launches the replacement while the
    // old instance is alive → two litestream writers on one generation path.
    (asg.node.defaultChild as autoscaling.CfnAutoScalingGroup).capacityRebalance = false;

    // --- Package outputs (consumer env contract) -----------------------------
    new cdk.CfnOutput(this, "awsRegion", { value: this.region });
    new cdk.CfnOutput(this, "sqliteReplicaBucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "registryTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "iamPolicySqliteRegistry", {
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
            ],
            Resource: [table.tableArn],
          },
        ],
      }),
    });
    new cdk.CfnOutput(this, "dataApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "iamPolicySqliteDataApi", {
      value: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["execute-api:Invoke"],
            Resource: [
              `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*/*/*`,
            ],
          },
        ],
      }),
    });
  }
}
