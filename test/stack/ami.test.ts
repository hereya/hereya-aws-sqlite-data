// Invariant 11/12: the ONLY things that may replace the production database VM
// are a new service and a deliberately bumped AMI pin. A "latest AL2023" lookup
// would re-resolve at every deploy and roll the instance on AWS's schedule.
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

// t_rca_p0_infra: the pin is per region (AMI ids are region-scoped). A region
// with a pin gets ITS id; a region without one fails at synth, never with an
// ASG that cannot launch.
function imageIdIn(region: string, id: string): unknown {
  const stack = new HereyaAwsSqliteDataStack(new cdk.App(), id, { env: { account: "111111111111", region } });
  const lt = Object.values(Template.fromStack(stack).findResources("AWS::EC2::LaunchTemplate"))[0]!;
  return lt.Properties.LaunchTemplateData.ImageId;
}

test("each pinned region gets its own pin — eu-west-1 unchanged, ca-central-1 the same image's Montréal id", () => {
  assert.equal(imageIdIn("eu-west-1", "TestStackAmiEu"), "ami-0e942ce8509bb33b6");
  assert.equal(imageIdIn("ca-central-1", "TestStackAmiCa"), "ami-0658cdb60624f22b1");
});

test("an unpinned region is refused at synth, with what to do", () => {
  assert.throws(() => imageIdIn("eu-central-1", "TestStackAmiRegion"), /No pinned AMI for eu-central-1/);
});

test("an explicit amiId still works in an unpinned region", () => {
  process.env.amiId = "ami-0123456789abcdef0";
  try {
    assert.equal(imageIdIn("eu-central-1", "TestStackAmiExplicit"), "ami-0123456789abcdef0");
  } finally {
    delete process.env.amiId;
  }
});

test("another region's pin passed as amiId is refused (it does not exist here)", () => {
  process.env.amiId = "ami-0e942ce8509bb33b6";
  try {
    assert.throws(() => imageIdIn("ca-central-1", "TestStackAmiWrongRegion"), /eu-west-1 and does not exist in ca-central-1/);
  } finally {
    delete process.env.amiId;
  }
});
