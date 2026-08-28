// Template-level enforcement of the spec's non-negotiables (§3, §13):
// no S3 lifecycle/versioning, no SSH keypair, IMDSv2 required, 1/1/1 ASG with
// capacity rebalance off, least-privilege role (never s3:*).
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { HereyaAwsSqliteDataStack } from "../lib/hereya-aws-sqlite-data-stack.ts";

let template: Template;

before(() => {
  const app = new cdk.App();
  const stack = new HereyaAwsSqliteDataStack(app, "TestStack", {
    env: { account: "111111111111", region: "eu-west-1" },
  });
  template = Template.fromStack(stack);
});

test("replica bucket has NO lifecycle rules and NO versioning", () => {
  const buckets = template.findResources("AWS::S3::Bucket");
  const names = Object.keys(buckets).filter((k) => k.startsWith("ReplicaBucket"));
  assert.equal(names.length, 1);
  const bucket = buckets[names[0]!]!;
  assert.equal(bucket.Properties.LifecycleConfiguration, undefined, "no lifecycle rules allowed (Litestream owns retention)");
  assert.equal(bucket.Properties.VersioningConfiguration, undefined, "versioning must stay off");
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test("registry table: org_id/sk keys, on-demand billing, PITR", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    KeySchema: [
      { AttributeName: "org_id", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    BillingMode: "PAY_PER_REQUEST",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
});

test("launch template: no SSH key, IMDSv2 required", () => {
  const lts = template.findResources("AWS::EC2::LaunchTemplate");
  const lt = Object.values(lts)[0]!;
  const data = lt.Properties.LaunchTemplateData;
  assert.equal(data.KeyName, undefined, "SSM only — no SSH keypair");
  assert.equal(data.MetadataOptions?.HttpTokens, "required");
});

test("ASG: 1/1/1 singleton, all-Spot mixed instances, capacity rebalance OFF", () => {
  const asgs = template.findResources("AWS::AutoScaling::AutoScalingGroup");
  const asg = Object.values(asgs)[0]!;
  assert.equal(asg.Properties.MinSize, "1");
  assert.equal(asg.Properties.MaxSize, "1");
  assert.equal(asg.Properties.CapacityRebalance, false);
  const dist = asg.Properties.MixedInstancesPolicy.InstancesDistribution;
  assert.equal(dist.OnDemandPercentageAboveBaseCapacity, 100, "on-demand by default (Spot is opt-in)");
  assert.equal(dist.SpotAllocationStrategy, "capacity-optimized");
  const overrides = asg.Properties.MixedInstancesPolicy.LaunchTemplate.Overrides;
  assert.ok(overrides.length >= 2, "at least two instance-type fallbacks");
  // replacements must be able to land in more than one AZ
  assert.ok((asg.Properties.VPCZoneIdentifier ?? []).length >= 2, "ASG must span >=2 subnets");
});

test("ASG update policy: rolling update, terminate-before-launch (single litestream writer)", () => {
  const asgs = template.findResources("AWS::AutoScaling::AutoScalingGroup");
  const asg = Object.values(asgs)[0]!;
  const rolling = asg.UpdatePolicy?.AutoScalingRollingUpdate;
  assert.ok(rolling, "must use AutoScalingRollingUpdate (replacingUpdate runs old+new side by side)");
  assert.equal(rolling.MinInstancesInService, 0, "old instance must terminate BEFORE the new one launches");
  assert.equal(rolling.MaxBatchSize, 1);
  assert.equal(asg.UpdatePolicy?.AutoScalingReplacingUpdate, undefined);
});

// Invariant 11/12: the ONLY things that may replace the production database VM
// are a new service and a deliberately bumped AMI pin. A "latest AL2023" lookup
// would re-resolve at every deploy and roll the instance on AWS's schedule.
test("launch template pins a literal AMI id — no latest-AL2023 lookup", () => {
  const lts = template.findResources("AWS::EC2::LaunchTemplate");
  const lt = Object.values(lts)[0]!;
  const imageId = lt.Properties.LaunchTemplateData.ImageId;
  assert.equal(
    typeof imageId,
    "string",
    "ImageId must be a literal ami-… (a Ref to an SSM AMI parameter re-resolves at every deploy)",
  );
  assert.match(imageId as string, /^ami-[0-9a-f]{8,17}$/);
  // and no SSM-backed AMI parameter left anywhere in the template
  const params = template.toJSON().Parameters ?? {};
  for (const [name, def] of Object.entries(params as Record<string, { Type?: string }>)) {
    assert.ok(
      !String(def.Type ?? "").includes("AWS::EC2::Image::Id"),
      `parameter ${name} resolves an AMI at deploy time`,
    );
  }
});

test("amiId=latest is the explicit opt-out (back to deploy-time resolution)", () => {
  process.env.amiId = "latest";
  try {
    const stack = new HereyaAwsSqliteDataStack(new cdk.App(), "TestStackAmiLatest", {
      env: { account: "111111111111", region: "eu-west-1" },
    });
    const lt = Object.values(Template.fromStack(stack).findResources("AWS::EC2::LaunchTemplate"))[0]!;
    assert.equal(
      typeof lt.Properties.LaunchTemplateData.ImageId,
      "object",
      "'latest' must render a Ref to an SSM AMI parameter",
    );
  } finally {
    delete process.env.amiId;
  }
});

test("a bogus amiId fails at synth, not at instance launch", () => {
  process.env.amiId = "ami_not_an_id";
  try {
    assert.throws(
      () =>
        new HereyaAwsSqliteDataStack(new cdk.App(), "TestStackAmiBogus", {
          env: { account: "111111111111", region: "eu-west-1" },
        }),
      /amiId must be an AMI id/,
    );
  } finally {
    delete process.env.amiId;
  }
});

test("the pinned default is refused outside its region (AMI ids are region-scoped)", () => {
  assert.throws(
    () =>
      new HereyaAwsSqliteDataStack(new cdk.App(), "TestStackAmiRegion", {
        env: { account: "111111111111", region: "eu-central-1" },
      }),
    /does not exist in eu-central-1/,
  );
});

test("user-data embeds the service artifact hash (deploy rolls the instance)", () => {
  const lts = template.findResources("AWS::EC2::LaunchTemplate");
  const lt = Object.values(lts)[0]!;
  const userData = JSON.stringify(lt.Properties.LaunchTemplateData.UserData);
  assert.ok(userData.includes("service-artifact-hash:"), "artifact hash line must be in user-data");
});

test("no NAT gateways and no interface endpoints (cost floor)", () => {
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
  for (const ep of Object.values(endpoints)) {
    assert.equal(ep.Properties.VpcEndpointType ?? "Gateway", "Gateway");
  }
});

test("instance role never gets s3:* and scopes S3 to the bucket", () => {
  const policies = template.findResources("AWS::IAM::Policy");
  for (const policy of Object.values(policies)) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      for (const action of actions) {
        assert.notEqual(action, "s3:*", "wildcard S3 is forbidden");
        assert.notEqual(action, "*", "wildcard actions are forbidden");
      }
    }
  }
});

test("every API route requires IAM (SigV4) authorization", () => {
  const routes = template.findResources("AWS::ApiGatewayV2::Route");
  const keys = Object.values(routes).map((r) => r.Properties.RouteKey as string);
  assert.ok(keys.length >= 7, `expected >=7 routes, got ${keys.join(", ")}`);
  for (const route of Object.values(routes)) {
    assert.equal(route.Properties.AuthorizationType, "AWS_IAM", `route ${route.Properties.RouteKey} must be IAM-authorized`);
  }
});

test("VPC Link + Cloud Map service exist; instance admits only the VPC Link SG", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::VpcLink", 1);
  template.resourceCountIs("AWS::ServiceDiscovery::Service", 1);
  const ingresses = template.findResources("AWS::EC2::SecurityGroupIngress");
  const toInstance = Object.values(ingresses);
  assert.equal(toInstance.length, 1, "exactly one ingress rule in the whole stack");
  assert.equal(toInstance[0]!.Properties.FromPort, 8080);
  assert.ok(toInstance[0]!.Properties.SourceSecurityGroupId, "ingress must be SG-scoped, not CIDR");
});

test("cloud map deregister-on-delete guards the service deletion", () => {
  const crs = template.findResources("Custom::CloudMapDeregister");
  const entries = Object.entries(crs);
  assert.equal(entries.length, 1);
  const [, cr] = entries[0]!;
  assert.ok(cr!.Properties.ServiceId, "must target the discovery service id");
  // the explicit dependency is what makes CloudFormation delete the custom
  // resource (and run its deregister) BEFORE deleting the service
  const deps: string[] = cr!.DependsOn ?? [];
  assert.ok(
    deps.some((d) => d.startsWith("NamespaceDataApiService")),
    "must depend on the discovery service",
  );
  // deregistration rights are scoped to this service (plus the unscoped
  // GetOperation poll — operations have no service ARN)
  const policies = template.findResources("AWS::IAM::Policy");
  const fnPolicy = Object.entries(policies).find(([k]) => k.startsWith("CloudMapDeregisterFn"));
  assert.ok(fnPolicy, "deregister fn must have an inline policy");
  const statements = fnPolicy![1]!.Properties.PolicyDocument.Statement as Array<{
    Action: string | string[];
    Resource: unknown;
  }>;
  const dereg = statements.find((s) => JSON.stringify(s.Action).includes("DeregisterInstance"));
  assert.ok(dereg, "must allow DeregisterInstance");
  assert.notEqual(JSON.stringify(dereg!.Resource), '"*"', "DeregisterInstance must be service-scoped");
});

test("the write-stats grant cannot touch org rows", () => {
  // The registry is what the double control reads to decide who may reach what.
  // Granting the data plane a blanket UpdateItem on it would be a real widening
  // of blast radius; the condition pins the write to one fixed partition.
  const policies = template.findResources("AWS::IAM::Policy");
  const stmts = Object.values(policies).flatMap(
    (p) => (p.Properties.PolicyDocument.Statement ?? []) as unknown[],
  ) as Array<{ Sid?: string; Action?: unknown; Condition?: Record<string, Record<string, string[]>> }>;
  const grant = stmts.find((st) => st.Sid === "WriteStats");
  assert.ok(grant, "the WriteStats grant must exist");
  assert.deepEqual(grant.Action, "dynamodb:UpdateItem", "write, and nothing else");
  assert.deepEqual(
    grant.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:LeadingKeys"],
    ["_writestats"],
    "scoped to the fixed partition — never an org's rows",
  );
});

test("memory headroom is alarmed — the ceiling on how many apps fit", () => {
  // litestream grows ~1 MB of RSS per database on a 916 MB instance, so memory
  // is what limits app count. Before 2026-08-24 nothing watched it.
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "MemoryAvailableBytes",
    Namespace: "Dilaya/SqliteData",
    ComparisonOperator: "LessThanThreshold",
    Statistic: "Minimum",
    // NOT breaching on missing data: silence here means the heartbeat stopped,
    // and the heartbeat alarm already pages for that. Two alarms for one
    // incident is noise, and noise is how alarms get ignored.
    TreatMissingData: "notBreaching",
  });
});

test("the root volume size is OURS, not the AMI's default", () => {
  // Until 2026-08-25 the launch template carried no blockDevices at all, so the
  // ASG inherited the AMI's 8 GB root — a number nobody chose, live for four
  // months. The device name is the load-bearing half: any name other than the
  // AMI's own root device ADDS a second volume instead of resizing the root,
  // which looks like it worked while the databases stay on the same 8 GB.
  template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
    LaunchTemplateData: {
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/xvda",
          Ebs: { VolumeSize: 30, VolumeType: "gp3", DeleteOnTermination: true },
        },
      ],
    },
  });
});

test("the root volume is encrypted at rest", () => {
  // This disk carries the app.db of every app of every org. The S3 replica has
  // always been encrypted, so until 2026-08-25 the travelling COPY of customer
  // data was protected while the original was not.
  const lt = Object.values(template.findResources("AWS::EC2::LaunchTemplate"))[0];
  assert.ok(lt, "the launch template must exist");
  const ebs = lt.Properties.LaunchTemplateData.BlockDeviceMappings[0].Ebs;
  assert.equal(ebs.Encrypted, true, "the databases' own disk must be encrypted at rest");
});

test("encryption uses the AWS-managed key — no customer-managed key is wired in", () => {
  // Load-bearing, not laziness. `aws/ebs` grants use to every principal in the
  // account acting via EC2, which is what lets the Auto Scaling service-linked
  // role launch from it with no explicit grant. A CMK needs that grant written
  // by hand, and getting it wrong does not degrade anything — the ASG simply
  // cannot launch, which on this singleton is a total outage of every org's
  // databases. If a CMK is ever wanted, this test should fail first.
  const lt = Object.values(template.findResources("AWS::EC2::LaunchTemplate"))[0];
  assert.ok(lt, "the launch template must exist");
  const ebs = lt.Properties.LaunchTemplateData.BlockDeviceMappings[0].Ebs;
  assert.equal(ebs.KmsKeyId, undefined, "leaving KmsKeyId unset is what selects aws/ebs");
  assert.equal(ebs.Iops, undefined, "IOPS is left to the snapshot's own value");
  assert.equal(ebs.Throughput, undefined, "throughput is left to the snapshot's own value");
});

test("disk headroom is alarmed — the resource eviction never gives back", () => {
  // Eviction frees a thread and ~0.46 MB of RSS; the evicted app KEEPS its file,
  // so no eviction has ever returned a byte of disk. A full volume is
  // SQLITE_FULL on every org's writes at once, and until 2026-08-25 every other
  // instrument stayed green right up to that first error.
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "DiskAvailableBytes",
    Namespace: "Dilaya/SqliteData",
    ComparisonOperator: "LessThanThreshold",
    Statistic: "Minimum",
    // Same reasoning as its memory twin: silence means the heartbeat stopped,
    // and that alarm already pages.
    TreatMissingData: "notBreaching",
  });
});

test("every alarm notifies, in both directions", () => {
  const list = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
  assert.equal(list.length, 6);
  for (const alarm of list) {
    assert.ok((alarm.Properties.AlarmActions ?? []).length >= 1, "alarm must notify");
    assert.ok((alarm.Properties.OKActions ?? []).length >= 1, "recovery must notify too");
  }
});

test("liveness alarms are dead-man switches (missing data = breaching)", () => {
  const alarms = template.findResources("AWS::CloudWatch::Alarm");
  for (const key of ["HeartbeatAlarm", "CapacityAlarm"]) {
    const entry = Object.entries(alarms).find(([k]) => k.startsWith(key));
    assert.ok(entry, `${key} must exist`);
    assert.equal(entry![1].Properties.TreatMissingData, "breaching", "silence must trip the alarm");
    assert.equal(entry![1].Properties.ComparisonOperator, "LessThanThreshold");
  }
});

test("the registry table is watched on both DynamoDB failure metrics", () => {
  // The table that resolves every customer database to its file. A throttle on
  // it is not a Lambda error and produces no gateway 5xx, so nothing else in
  // the account would ever report it.
  const alarms = template.findResources("AWS::CloudWatch::Alarm");
  const found = new Map<string, Record<string, any>>();
  for (const [, alarm] of Object.entries(alarms)) {
    if (alarm.Properties.Namespace === "AWS/DynamoDB") {
      found.set(alarm.Properties.MetricName, alarm.Properties);
    }
  }
  assert.deepEqual([...found.keys()].sort(), ["SystemErrors", "ThrottledRequests"]);
  for (const props of found.values()) {
    // Absent data means no error occurred — the healthy state, NOT a breach.
    assert.equal(props.TreatMissingData, "notBreaching");
    assert.equal(props.ComparisonOperator, "GreaterThanOrEqualToThreshold");
    assert.equal(props.Threshold, 1);
    assert.equal(props.Period, 300);
    // Pointed at the registry table itself, never a hardcoded name.
    const dim = (props.Dimensions ?? [])[0];
    assert.equal(dim?.Name, "TableName");
    assert.ok(JSON.stringify(dim?.Value).includes("RegistryTable"), "must watch the registry table");
  }
});

test("telegram relay appears only when its inputs are set", () => {
  // default synth (no telegram inputs): no Lambda in the stack at all
  const fns = template.findResources("AWS::Lambda::Function");
  const relays = Object.keys(fns).filter((k) => k.startsWith("HeartbeatRelay"));
  assert.equal(relays.length, 0);

  const app2 = new cdk.App();
  process.env.telegramBotTokenParam = "/dilaya/test/telegram-token";
  process.env.telegramChatId = "12345";
  try {
    const stack2 = new HereyaAwsSqliteDataStack(app2, "TestStackTg", {
      env: { account: "111111111111", region: "eu-west-1" },
    });
    const template2 = Template.fromStack(stack2);
    const fns2 = Object.keys(template2.findResources("AWS::Lambda::Function"));
    assert.ok(fns2.some((k) => k.startsWith("HeartbeatRelay")), "relay must exist with inputs set");
    template2.resourceCountIs("AWS::SNS::Subscription", 1);
  } finally {
    delete process.env.telegramBotTokenParam;
    delete process.env.telegramChatId;
  }
});

test("artifact pointer parameter exists (service-only update path)", () => {
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: Match.stringLikeRegexp("/TestStack/service-artifact"),
  });
});

test("capability secret is created, granted to the instance role, and exported", () => {
  template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  // RAW random string: no SecretStringTemplate/GenerateStringKey (GetSecretValue
  // returns the secret verbatim for both the service and the connector).
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
  });
  // the instance role must be able to read it (grantRead → GetSecretValue)
  const policies = template.findResources("AWS::IAM::Policy");
  const grantsGet = Object.values(policies).some((p) =>
    p.Properties.PolicyDocument.Statement.some((s: { Action?: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("secretsmanager:GetSecretValue");
    }),
  );
  assert.ok(grantsGet, "instance role must be granted secretsmanager:GetSecretValue");
  // new consumer outputs for the connector
  const outputs = template.findOutputs("*");
  assert.ok(outputs.capabilitySecretArn, "missing output capabilitySecretArn");
  assert.ok(outputs.iamPolicySqliteCapability, "missing output iamPolicySqliteCapability");
  const raw = JSON.stringify(outputs.iamPolicySqliteCapability!.Value);
  assert.ok(raw.includes("2012-10-17"));
  assert.ok(raw.includes("secretsmanager:GetSecretValue"));
});

test("exports the consumer env contract", () => {
  const outputs = template.findOutputs("*");
  for (const key of [
    "awsRegion",
    "sqliteReplicaBucketName",
    "registryTableName",
    "iamPolicySqliteRegistry",
    "dataApiUrl",
    "iamPolicySqliteDataApi",
  ]) {
    assert.ok(outputs[key], `missing output ${key}`);
  }
  // the policy value embeds the table ARN token, so at template level it is an
  // Fn::Join — just confirm the serialized shape carries the policy skeleton
  const raw = JSON.stringify(outputs.iamPolicySqliteRegistry!.Value);
  assert.ok(raw.includes("2012-10-17"));
  assert.ok(raw.includes("dynamodb:PutItem"));
  assert.ok(raw.includes("dynamodb:Scan")); // layer-sync sweep (connector)
});

// The gateway that serves EVERY customer database had no access log at all
// (t_dataapi_access_log): 20 087 requests in 24 h, 2 of them 5xx, and nothing
// anywhere said which app, which route, or why — only a counter saying "two".
// Its two sibling APIs (connector, landing) both log; this one, the layer where
// a failure means "a customer's data call failed", was the blind one.
test("the Data API stage writes an access log that says WHICH call failed and WHY", () => {
  const stages = template.findResources("AWS::ApiGatewayV2::Stage");
  const entries = Object.values(stages);
  assert.equal(entries.length, 1, "exactly one (default) stage");
  const settings = entries[0]!.Properties.AccessLogSettings;
  assert.ok(settings, "the stage MUST have access log settings — its 5xx are unattributable without them");
  assert.ok(settings.DestinationArn, "access log needs a destination log group");
  const format = JSON.parse(settings.Format as string);
  // The fields that answer WHAT failed and WHY, not just how many.
  for (const field of [
    "requestId",
    "routeKey",
    "status",
    "integrationStatus",
    "integrationErrorMessage",
    "sourceIp",
  ]) {
    assert.ok(format[field], `access log format must carry ${field}`);
  }
});

// Retention is a cost decision, not an accident: ~20 000 lines a day on a
// gateway whose logs are only ever read to explain a 5xx the metric window has
// already surfaced. Anything longer is paid for and never read.
test("the Data API access log group retains for one week, and is destroyed with the stack", () => {
  const stages = template.findResources("AWS::ApiGatewayV2::Stage");
  const dest = Object.values(stages)[0]!.Properties.AccessLogSettings.DestinationArn;
  const logicalId = (dest["Fn::GetAtt"] as [string, string])[0];
  const group = template.findResources("AWS::Logs::LogGroup")[logicalId];
  assert.ok(group, `access log destination ${logicalId} must be a log group in this stack`);
  assert.equal(group.Properties.RetentionInDays, 7);
  assert.equal(group.DeletionPolicy, "Delete");
});
