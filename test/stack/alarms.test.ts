// What watches the VM: the resource-headroom alarms, the dead-man switches, the
// registry-table failure metrics, and the Telegram relay that carries them.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { HereyaAwsSqliteDataStack } from "../../lib/hereya-aws-sqlite-data-stack.ts";
import { buildTemplate } from "./helpers.ts";

let template: Template;

before(() => {
  template = buildTemplate();
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
