import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { execSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUserData } from "./user-data.ts";
import { serviceContentHash } from "./service-hash.ts";
// The instance AMI is PINNED (see CLAUDE.md invariant 12). Moving it replaces
// the production database VM, so it moves only when a human bumps the constant
// — never because AWS published something. The pin and the check that tells us
// it has fallen behind (`npm run check:ami`) live together in ./ami-pin.ts.
import { PINNED_AMI_ID, PINNED_AMI_REGION } from "./ami-pin.ts";

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
      description: "Dilaya SQLite Data API instance - no public ingress; API GW VPC Link only",
      allowAllOutbound: true,
    });

    // --- Discovery + API Gateway (IAM/SigV4) ---------------------------------
    // Cloud Map + VPC Link v2 is the no-load-balancer private integration:
    // the singleton registers its own IP; API GW discovers it. The instance SG
    // only ever admits the VPC Link's SG on the service port.
    const vpcLinkSg = new ec2.SecurityGroup(this, "VpcLinkSg", {
      vpc,
      description: "API Gateway VPC Link to Data API instance",
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

    // Destroy caveat (runbook): Cloud Map refuses to delete a service that
    // still has registered instances, and the instance's self-registration
    // outlives it when the ASG tears down in parallel — leaving `cdk destroy`
    // DELETE_FAILED until someone deregisters by hand. This custom resource
    // depends on the service, so CloudFormation deletes it FIRST; its
    // on-delete deregisters whatever is still registered. Fail-open: on any
    // error the stack delete proceeds and, at worst, fails on the service
    // exactly like before (the manual runbook still applies).
    const deregisterFn = new lambda.Function(this, "CloudMapDeregisterFn", {
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
    const deregisterOnDelete = new cdk.CustomResource(this, "CloudMapDeregisterOnDelete", {
      serviceToken: deregisterFn.functionArn,
      resourceType: "Custom::CloudMapDeregister",
      properties: { ServiceId: discoveryService.serviceId },
    });
    deregisterOnDelete.node.addDependency(discoveryService);

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
      [apigwv2.HttpMethod.POST, "/admin/delete-app"],
      [apigwv2.HttpMethod.GET, "/stats"],
      [apigwv2.HttpMethod.GET, "/health"],
    ] as const) {
      httpApi.addRoutes({ path, methods: [method], integration });
    }

    // --- Service artifact ----------------------------------------------------
    const artifact = new s3assets.Asset(this, "ServiceArtifact", {
      path: join(repoRoot, "service"),
      // Hash the service's INPUTS, never the built tarball. The hash rides in
      // the launch template, so it decides when CloudFormation replaces the
      // database VM — and `AssetHashType.OUTPUT` made that decision on a
      // tarball that is not reproducible (builtAt timestamp + tar/gzip mtimes),
      // so every deploy of anything rolled the databases for ~1 min. See
      // lib/service-hash.ts for the measurement.
      assetHash: serviceContentHash(repoRoot),
      assetHashType: cdk.AssetHashType.CUSTOM,
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
        // GetBucketLocation: litestream resolves the bucket region before restore
        actions: ["s3:ListBucket", "s3:GetBucketLocation"],
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
    // Per-app write recency (service/src/write-stats.ts). WRITE access is
    // granted, but ONLY into the fixed `_writestats` partition — the condition
    // is on the partition key itself, so this role still cannot touch a single
    // org or app row. That matters: the registry is the source of truth the
    // double control reads, and the data plane has no business writing to it.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteStats",
        actions: ["dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["_writestats"] },
        },
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

    // --- Capability token secret (spec §6 caller-binding) --------------------
    // The connector mints per-request HMAC capability tokens with this secret;
    // the VM re-derives the HMAC and checks the token's (org, app) matches the
    // request. RAW random string — no SecretStringTemplate/GenerateStringKey —
    // so GetSecretValue returns the secret verbatim (both the service and the
    // connector read SecretString as-is, not a JSON key).
    const capabilitySecret = new secretsmanager.Secret(this, "CapabilitySecret", {
      description: "Dilaya SQLite Data API capability-token HMAC secret (shared with the connector)",
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
      removalPolicy,
    });
    // The instance role reads the secret at boot to verify incoming tokens.
    capabilitySecret.grantRead(role);

    // --- Launch template + self-healing Spot singleton ----------------------
    const userData = ec2.UserData.custom(
      buildUserData({
        awsRegion: this.region,
        artifactParamName: artifactParam.parameterName,
        artifactHash: artifact.assetHash,
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
          // Housekeeping cadence — the S3 REQUEST bill, not durability. See the
          // parameter docs in hereyarc.yaml.
          LITESTREAM_L0_RETENTION: input("litestreamL0Retention", "3h"),
          LITESTREAM_L0_RETENTION_CHECK_INTERVAL: input("litestreamL0RetentionCheckInterval", "30m"),
          LITESTREAM_LEVEL_INTERVALS: input("litestreamLevelIntervals", "30m,2h,6h"),
          // Boot-restore fan-out. This is an AVAILABILITY setting, not a cost
          // one: the whole restore window is a total outage for every org, and
          // it was serial until 2026-08-24 (61 apps, 72s measured). See the
          // parameter docs in hereyarc.yaml.
          BOOT_RESTORE_CONCURRENCY: input("bootRestoreConcurrency", "8"),
          // Per-app write recency — the hot path is memory only; this is how
          // often it is persisted so it survives an instance replacement.
          WRITE_STATS_FLUSH_MS: input("writeStatsFlushMs", "300000"),
          // Eviction: days without a WRITE before an app leaves the litestream
          // config (it stays served and readable). "0" = off, and off is the
          // default on purpose — the threshold is what makes eviction safe (it
          // must dwarf the ~1s replication lag), so it is never inferred.
          EVICTION_IDLE_DAYS: input("evictionIdleDays", "0"),
          EVICTION_SWEEP_MS: input("evictionSweepMs", "3600000"),
          HEARTBEAT_ENABLED: "1",
          HEARTBEAT_DIMENSION: this.stackName,
          IMDS_ENABLED: "1",
          CLOUDMAP_SERVICE_ID: discoveryService.serviceId,
          // Capability-token validation: the service fetches the secret by ARN
          // at boot. Enforcement defaults OFF (rollout-compat window) — flip via
          // the capabilityEnforce input once every connector mints tokens.
          CAPABILITY_SECRET_ARN: capabilitySecret.secretArn,
          CAPABILITY_ENFORCE: input("capabilityEnforce", "false"),
        },
      }),
    );

    // Root volume size. Until 2026-08-25 this was not set AT ALL: the launch
    // template carried no blockDevices, so the ASG silently inherited the AMI's
    // own 8 GB root — a number nobody chose, running in production for four
    // months. Same class of problem as the AMI before it was pinned (invariant
    // 12): a value we were SUBJECT TO rather than one we own. Left implicit, a
    // future AMI bump could change the disk size on its own.
    //
    // The default comes from the sizing law measured in t_7f06618a3f17:
    //   disk needed ~= 3x total database bytes + ~2.3 GB of OS
    // Today that is 726 MB of databases -> 4.5 GB, which the old 8 GB did hold;
    // 30 GB buys roughly an order of magnitude of growth for ~2 USD/month.
    //
    // ⚠ Changing this rolls the instance (new launch template version, ~60 s
    // with no Data API) — which is also what APPLIES the new size. Nothing to
    // do on the box: cloud-init runs `growpart` and the root is XFS, so the
    // partition and filesystem extend themselves on the next boot.
    const rootVolumeGb = Number(input("rootVolumeGb", "30"));
    if (!Number.isInteger(rootVolumeGb) || rootVolumeGb < 8 || rootVolumeGb > 16384) {
      throw new Error(
        `invalid rootVolumeGb: ${input("rootVolumeGb", "30")} (expected a whole number of GB, 8..16384)`,
      );
    }

    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      machineImage: this.resolveMachineImage(input("amiId", PINNED_AMI_ID).trim()),
      instanceType: new ec2.InstanceType(instanceType),
      role,
      securityGroup: instanceSg,
      userData,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      // The device name MUST be the AMI's own root device (`/dev/xvda` on
      // AL2023 arm64) — any other name ADDS a second volume instead of resizing
      // the root, which would look like it worked while the databases stayed on
      // the same 8 GB.
      //
      // Size and encryption are stated; IOPS and throughput are left to the
      // snapshot's own values (3000 / 125).
      //
      // ENCRYPTED AT REST since 2026-08-25. This volume carries the `app.db` of
      // every app of every org, and it was the asymmetry that made the gap
      // obvious: the S3 replica has always been encrypted (`S3_MANAGED`, the
      // ReplicaBucket above), so the travelling COPY of customer data was
      // protected while the original was not.
      //
      // The key is the account's AWS-managed `aws/ebs`, reached by leaving
      // `kmsKey` unset — and that choice is load-bearing, not laziness. Its key
      // policy grants Encrypt/GenerateDataKey/CreateGrant to EVERY principal in
      // the account acting `ViaService: ec2.<region>.amazonaws.com`, which is
      // what lets the Auto Scaling service-linked role launch from it with no
      // extra grant. A CUSTOMER-MANAGED key would need that grant written
      // explicitly, and getting it wrong does not degrade anything — the ASG
      // simply cannot launch, which on this singleton is a total outage of
      // every org's databases. So no CMK parameter is offered here on purpose.
      //
      // Verified before shipping (2026-08-25): a throwaway t4g.micro launched
      // from this very pinned AMI with an encrypted 30 GB root reached
      // `running`, proving the snapshot -> encrypted-root conversion works in
      // this account and region. Encryption-by-default is OFF account-wide, and
      // no encrypted volume had ever existed here, so nothing about this path
      // could be assumed from prior art.
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(rootVolumeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
            encrypted: true,
          }),
        },
      ],
      // Spot-ness lives in the ASG's MixedInstancesPolicy below (a launch
      // template with InstanceMarketOptions conflicts with mixed instances).
      // no keyPair: SSM Session Manager only (spec §3)
    });

    // Still a singleton (one instance at a time — no litestream dual-writer),
    // but replacements may land in EITHER public subnet and on either size.
    // Purchasing default is ON-DEMAND: observed reality (eu-west-1, t4g) is
    // that Spot can be unfulfillable across AZs and sizes for extended periods,
    // which turns the spec's ~2-min recovery into an open-ended outage. Spot
    // remains an explicit opt-in via spotPercentage (0-100).
    const spotPercentage = Math.min(100, Math.max(0, Number(input("spotPercentage", "0")) || 0));
    const asg = new autoscaling.AutoScalingGroup(this, "Asg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      mixedInstancesPolicy: {
        launchTemplate,
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType(instanceType) },
          { instanceType: new ec2.InstanceType(input("fallbackInstanceType", "t4g.small")) },
        ],
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity: 100 - spotPercentage,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
        },
      },
      minCapacity: 1,
      maxCapacity: 1,
      // Rolling update with minInstancesInService=0 = TERMINATE-BEFORE-LAUNCH:
      // CloudFormation kills the old instance, then brings up the new one — the
      // same sequence as the tested kill-instance recovery (~1 min gap), and the
      // only order compatible with the litestream single-writer invariant. Do
      // NOT switch back to replacingUpdate(): it runs old and new side by side.
      // What rolls the instance is therefore, by design, exactly two deliberate
      // changes: a new SERVICE (the source hash in user-data) and a bumped AMI
      // pin. Ordinary deploys leave the databases alone.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
        pauseTime: cdk.Duration.seconds(0),
        waitOnResourceSignals: false,
      }),
      groupMetrics: [autoscaling.GroupMetrics.all()],
    });
    // Capacity rebalance must stay OFF: it launches the replacement while the
    // old instance is alive → two litestream writers on one generation path.
    (asg.node.defaultChild as autoscaling.CfnAutoScalingGroup).capacityRebalance = false;

    // --- Heartbeat dead-man switch + Telegram relay (spec §3, « le silence est
    // interdit ») ------------------------------------------------------------
    const alertTopic = new sns.Topic(this, "AlertTopic");

    // Default 150 MB: on the default 916 MB instance that is roughly the point
    // where ~150 more databases would no longer fit, i.e. enough warning to
    // plan a bigger instance rather than discover the wall by hitting it.
    const memoryHeadroomBytes = Number(input("memoryHeadroomBytes", "157286400"));
    if (!Number.isFinite(memoryHeadroomBytes) || memoryHeadroomBytes <= 0) {
      throw new Error(`invalid memoryHeadroomBytes: ${input("memoryHeadroomBytes", "157286400")}`);
    }

    // Default 1.5 GiB. Measured on the production volume 2026-08-25: 8.5 GB
    // total, 4.14 GB free, 2.10 GB of it the database directory — the disk is
    // already HALF FULL, which is not what anyone would have guessed from the
    // size of the databases (726 MB of app.db across 61 apps). Growth is ~0.5
    // GB/month over the four months this VM has served customers, so 1.5 GiB of
    // headroom is roughly three months of warning: enough to grow the gp3
    // volume (an online operation) deliberately rather than at 3am.
    const diskHeadroomBytes = Number(input("diskHeadroomBytes", "1610612736"));
    if (!Number.isFinite(diskHeadroomBytes) || diskHeadroomBytes <= 0) {
      throw new Error(`invalid diskHeadroomBytes: ${input("diskHeadroomBytes", "1610612736")}`);
    }

    const heartbeatAlarm = new cloudwatch.Alarm(this, "HeartbeatAlarm", {
      alarmName: `${this.stackName}-heartbeat`,
      alarmDescription:
        "Dilaya SQLite Data API heartbeat is silent (instance dead, service wedged, replication down, or network cut)",
      metric: new cloudwatch.Metric({
        namespace: "Dilaya/SqliteData",
        metricName: "Heartbeat",
        dimensionsMap: { stack: this.stackName },
        statistic: "Sum",
        period: cdk.Duration.minutes(1),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    heartbeatAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    heartbeatAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

    const capacityAlarm = new cloudwatch.Alarm(this, "CapacityAlarm", {
      alarmName: `${this.stackName}-no-instance`,
      alarmDescription: "The Data API ASG has zero in-service instances",
      metric: new cloudwatch.Metric({
        namespace: "AWS/AutoScaling",
        metricName: "GroupInServiceInstances",
        dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
        statistic: "Minimum",
        period: cdk.Duration.minutes(1),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    capacityAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    capacityAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

    // Memory headroom. The two alarms above catch the VM being DEAD; this one
    // catches it running out of room to grow, which is the failure that
    // actually limits how many apps can be sold.
    //
    // Measured 2026-08-24 (scripts/loadtest.mjs, N = 20..1000):
    //   RSS ~= 65 MB baseline + 0.268 MB per database.
    // NB the first reading of this — 56.9 MB at 61 databases — was divided to
    // give "0.93 MB per database", which overstated the MARGINAL cost by ~3.4x:
    // most of that total is a baseline litestream pays once, not per database.
    // The ceiling on the default 916 MB instance is therefore around two
    // thousand apps rather than a few hundred — still far nearer than any cost
    // ceiling, which is why this alarm exists. Until it did, the number could
    // only be had by opening an SSM session and running `ps` by hand, which is
    // to say it was never had at all.
    //
    // NOT treatMissingData.BREACHING, unlike its neighbours: missing data here
    // means the heartbeat stopped, and the heartbeat alarm already says so
    // loudly. Making this one breach too would turn one incident into two
    // pages that say the same thing.
    const memoryAlarm = new cloudwatch.Alarm(this, "MemoryHeadroomAlarm", {
      alarmName: `${this.stackName}-memory-headroom`,
      alarmDescription:
        "Available memory on the Data API VM is low — litestream grows with the number of databases served, so this is the ceiling on how many apps this instance can hold",
      metric: new cloudwatch.Metric({
        namespace: "Dilaya/SqliteData",
        metricName: "MemoryAvailableBytes",
        dimensionsMap: { stack: this.stackName },
        statistic: "Minimum",
        period: cdk.Duration.minutes(5),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: memoryHeadroomBytes,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    memoryAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    memoryAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

    // Disk headroom — the third resource, and the only one that cannot be
    // recovered by the machine itself.
    //
    // Eviction defends the other two: an idle app leaves the litestream config,
    // freeing a thread and ~0.46 MB of RSS. It deliberately does NOT delete the
    // file, so no eviction has ever returned a single byte of disk. Databases of
    // deleted customers are not removed either. Disk is therefore the one curve
    // that only goes up.
    //
    // What it looks like when it ends: `SQLITE_FULL` on the writes of EVERY org
    // at once — and until this metric existed, every other instrument stayed
    // green right up to that first error. The heartbeat beats (the process is
    // alive), memory is free, threads are fine, the Lambdas raise nothing while
    // nobody writes, CloudFront serves 200s. Same shape as the other findings of
    // this sweep: a layer no existing instrument could see, not an instrument
    // read badly.
    //
    // Measured 2026-08-25 on the production volume, and it is not what the
    // database sizes suggest: 2.10 GB in the database directory, of which only
    // 726 MB is the app.db files — the other 1.37 GB is litestream's local
    // staging directories (~1.9x the databases they replicate).
    //
    // NOT breaching on missing data, for the same reason as its memory twin:
    // silence means the heartbeat stopped, and that alarm already pages.
    const diskAlarm = new cloudwatch.Alarm(this, "DiskHeadroomAlarm", {
      alarmName: `${this.stackName}-disk-headroom`,
      alarmDescription:
        "Free space on the Data API VM is low — every org's writes fail together when this volume fills, and eviction never frees disk (an evicted app keeps its file), so this number only ever falls",
      metric: new cloudwatch.Metric({
        namespace: "Dilaya/SqliteData",
        metricName: "DiskAvailableBytes",
        dimensionsMap: { stack: this.stackName },
        statistic: "Minimum",
        period: cdk.Duration.minutes(5),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: diskHeadroomBytes,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    diskAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    diskAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

    // The registry table is the piece that says WHERE each customer database
    // lives, and it was the one thing on this stack nothing watched. The
    // connector's deploy package already alarms its own AppStateTable on the
    // same two metrics; the asymmetry had no reason, and this table is the more
    // critical of the two — a throttle here does not break one app, it breaks
    // the resolution of every database at once.
    //
    // Neither metric surfaces anywhere else: a DynamoDB throttle is not a Lambda
    // error (the `Errors` metric stays 0) and produces no gateway 5xx when the
    // caller retries, so without these it is visible only to someone reading the
    // console by hand. Baseline is a flat zero (measured over 24 h on all five
    // tables of the account, 2026-08-12), hence threshold 1 over a single 5 min
    // period — the same shape the connector uses.
    for (const [metricName, suffix] of [
      ["SystemErrors", "registry-system-errors"],
      ["ThrottledRequests", "registry-throttles"],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, `Registry${metricName}Alarm`, {
        alarmName: `${this.stackName}-${suffix}`,
        alarmDescription: `Dilaya SQLite Data API: RegistryTable ${metricName} >= 1 in 5 min (baseline is 0).`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/DynamoDB",
          metricName,
          dimensionsMap: { TableName: table.tableName },
          statistic: "Sum",
          period: cdk.Duration.minutes(5),
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 1,
        // NOT the dead-man treatment of the two above: no datapoint here means
        // no error happened, which is the healthy state.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
      alarm.addOkAction(new cwActions.SnsAction(alertTopic));
    }

    // Telegram relay is wired only when the package inputs are provided; the
    // alarms exist regardless (visible in CloudWatch, other subscribers possible).
    const telegramTokenParam = input("telegramBotTokenParam", "");
    const telegramChatId = input("telegramChatId", "");
    if (telegramTokenParam !== "" && telegramChatId !== "") {
      const relay = new lambda.Function(this, "HeartbeatRelay", {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code: lambda.Code.fromAsset(join(repoRoot, "lib", "heartbeat-relay")),
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
              this,
            ),
          ],
        }),
      );
      alertTopic.addSubscription(new snsSubs.LambdaSubscription(relay));
    }

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
              // Scan: the connector's layer-sync sweep enumerates deployed
              // backends across ALL orgs (app# rows with lambdaFunctionName).
              "dynamodb:Scan",
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
    // The connector reads this secret to mint capability tokens; the iamPolicy*
    // output auto-attaches secretsmanager:GetSecretValue to the connector's role
    // (mirrors iamPolicySqliteRegistry / iamPolicySqliteDataApi wiring).
    new cdk.CfnOutput(this, "capabilitySecretArn", { value: capabilitySecret.secretArn });
    new cdk.CfnOutput(this, "iamPolicySqliteCapability", {
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

  /**
   * The VM's AMI — pinned by default, on purpose.
   *
   * `MachineImage.latestAmazonLinux2023()` re-resolves "the newest AL2023" at
   * EVERY deploy. AWS publishes one roughly monthly, so the next deploy after a
   * publication — of ANYTHING, including an unrelated connector release — hands
   * the launch template a different ImageId, and the rolling update
   * (`minInstancesInService: 0`) terminates the production database VM to apply
   * it: ~60 s with no Data API for every org, at a moment nobody chose. Same
   * shape as the artifact-hash incident of 2026-07-29/30 (CLAUDE.md inv. 11).
   *
   * So the id is a constant. It moves when someone bumps `PINNED_AMI_ID` or
   * passes `amiId`, i.e. on a dated, announced deploy. The accepted trade-off:
   * OS security patches no longer ride in by accident — they arrive when we
   * roll the pin, which the daily scan surfaces. `amiId=latest` restores the
   * old auto-resolving behaviour (surprise roll included).
   */
  private resolveMachineImage(amiId: string): ec2.IMachineImage {
    if (amiId === "latest") {
      return ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      });
    }
    if (!/^ami-[0-9a-f]{8,17}$/.test(amiId)) {
      throw new Error(
        `amiId must be an AMI id ("ami-…") or the literal "latest"; got ${JSON.stringify(amiId)}`,
      );
    }
    // An AMI id is region-scoped: the pinned default only exists in eu-west-1.
    // Fail here rather than with an ASG that cannot launch anything.
    if (
      amiId === PINNED_AMI_ID &&
      !cdk.Token.isUnresolved(this.region) &&
      this.region !== PINNED_AMI_REGION
    ) {
      throw new Error(
        `The default amiId (${PINNED_AMI_ID}) is an AL2023 arm64 image of ${PINNED_AMI_REGION} and does not exist in ${this.region}. ` +
          `Pass amiId=<an arm64 AL2023 AMI of ${this.region}>, or amiId=latest to resolve it at deploy time.`,
      );
    }
    // Deliberately not MachineImage.genericLinux(): that needs a region map and
    // a resolved region. The launch template supplies its own user data, so the
    // one here is a placeholder (LaunchTemplate: props.userData ?? image's).
    return {
      getImage: () => ({
        imageId: amiId,
        osType: ec2.OperatingSystemType.LINUX,
        userData: ec2.UserData.forLinux(),
      }),
    };
  }
}
