// `npm run check:ami` measures ONE region for all three questions — the pin,
// the published image, the running instance. Regression guarded (sweep of
// 2026-11-18): the region came from `--region` only, so
// `AWS_REGION=ca-central-1 … --stack <ca stack>` compared the eu-west-1 pin and
// searched eu-west-1 for a Canadian stack — exit 1 for the wrong reason, and the
// Canadian instance never checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PINNED_AMI_IDS } from "../lib/ami-pin.ts";
import {
  PACKAGE_STACK_MARKER_OUTPUT,
  combineExitCodes,
  describeStackRegion,
  isPackageStack,
  pickRunningImage,
  resolveRegion,
} from "../lib/ami-region.ts";

test("AWS_REGION is honoured when no --region is passed", () => {
  assert.deepEqual(resolveRegion(undefined, { AWS_REGION: "ca-central-1" }, "eu-west-1"), {
    region: "ca-central-1",
    source: "AWS_REGION",
  });
});

test("--region wins over the environment", () => {
  const r = resolveRegion("eu-west-1", { AWS_REGION: "ca-central-1", AWS_DEFAULT_REGION: "x" }, "d");
  assert.deepEqual(r, { region: "eu-west-1", source: "--region" });
});

test("AWS_REGION before AWS_DEFAULT_REGION, then the default; empty means unset", () => {
  assert.equal(resolveRegion(undefined, { AWS_REGION: "a", AWS_DEFAULT_REGION: "b" }, "d").region, "a");
  assert.deepEqual(resolveRegion(undefined, { AWS_REGION: "", AWS_DEFAULT_REGION: "b" }, "d"), {
    region: "b",
    source: "AWS_DEFAULT_REGION",
  });
  assert.deepEqual(resolveRegion(undefined, { AWS_REGION: "" }, "d"), { region: "d", source: "default" });
});

test("every pinned region resolves to its OWN pin, distinct per region", () => {
  // The script reads PINNED_AMI_IDS[region]; if the regions shared an id the
  // eu-west-1 one would silently stand in for the others.
  for (const region of ["eu-west-1", "ca-central-1"]) {
    const { region: r } = resolveRegion(undefined, { AWS_REGION: region }, "eu-west-1");
    assert.ok(PINNED_AMI_IDS[r], `no pin for ${r}`);
  }
  assert.notEqual(PINNED_AMI_IDS["eu-west-1"], PINNED_AMI_IDS["ca-central-1"]);
});

test("any running instance off the pin is the one compared — not just the first listed", () => {
  assert.equal(pickRunningImage(["ami-pin", "ami-old"], "ami-pin"), "ami-old");
  assert.equal(pickRunningImage(["ami-pin", "ami-pin"], "ami-pin"), "ami-pin");
  assert.equal(pickRunningImage([], "ami-pin"), null);
});

test("stack discovery keys on this package's own output only", () => {
  assert.equal(isPackageStack(["dataApiUrl", PACKAGE_STACK_MARKER_OUTPUT]), true);
  // The forked hereya/aws-sqlite-db shares these names and is NOT under this pin.
  assert.equal(isPackageStack(["dataApiUrl", "iamPolicySqliteDataApi", "registryTableName"]), false);
  assert.equal(isPackageStack([]), false);
});

test("across regions a roll (1) outranks blindness (2), which outranks sync (0)", () => {
  assert.equal(combineExitCodes([0, 2, 1]), 1);
  assert.equal(combineExitCodes([0, 2, 0]), 2);
  assert.equal(combineExitCodes([0, 0]), 0);
  assert.equal(combineExitCodes([]), 0);
});

test("a stack in another region is named, with the flag that reaches it", () => {
  const line = describeStackRegion("s", "eu-west-1", ["ca-central-1"]);
  assert.match(line, /does not exist in eu-west-1/);
  assert.match(line, /--region ca-central-1/);
  assert.match(describeStackRegion("s", "eu-west-1", []), /not found in any pinned region/);
});
