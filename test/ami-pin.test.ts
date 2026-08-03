// The AMI pin protects the production database VM from being replaced by an
// unrelated deploy (CLAUDE.md invariant 12). Its cost is that OS patches stop
// arriving on their own, which is only acceptable if something NOTICES that the
// pin has fallen behind.
//
// Regression guarded: that "something" was prose in two documents for weeks and
// was never executed once — on 2026-08-03 a sweep found an image four weeks
// old. These tests pin the properties that make the replacement (a command with
// an exit code) trustworthy: it must not report health when it cannot see, and
// it must tell a behind PIN apart from an un-rolled DEPLOY, because the two
// have different fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AL2023_SSM_PARAMETER,
  PINNED_AMI_ID,
  PINNED_AMI_REGION,
  amiPinStatus,
  describeVerdict,
} from "../lib/ami-pin.ts";

const AMI_A = "ami-0ab117b5527d5fe24";
const AMI_B = "ami-0390cc9c657024910";

test("pin equal to the published image is current", () => {
  assert.deepEqual(amiPinStatus({ pinned: AMI_A, latest: AMI_A }), {
    state: "current",
  });
});

test("a newer published image is reported as behind, and names it", () => {
  const v = amiPinStatus({ pinned: AMI_B, latest: AMI_A });
  assert.equal(v.state, "behind");
  assert.equal(v.state === "behind" && v.latest, AMI_A);
});

test("an unreadable parameter is 'unknown', NEVER 'current'", () => {
  // The whole point of the check is to be the thing that notices. A check that
  // passes when blind manufactures reassurance nobody verified — which is
  // exactly the failure mode (a clean-looking result hiding an unlooked-at
  // machine) that this file exists to end.
  const v = amiPinStatus({ pinned: AMI_A, latest: null });
  assert.equal(v.state, "unknown");
  assert.match(v.state === "unknown" ? v.reason : "", /al2023/i);
});

test("a running instance on neither image is 'instance-stale', not 'behind'", () => {
  // Different cause, different fix: the pin is current, so there is nothing to
  // edit — a previous bump was published and never rolled out, and the remedy
  // is a deploy. Reporting this as 'behind' would send someone to bump a
  // constant that is already right.
  const v = amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_B });
  assert.equal(v.state, "instance-stale");
  assert.equal(v.state === "instance-stale" && v.running, AMI_B);
});

test("a running instance that matches the pin is current", () => {
  assert.deepEqual(
    amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_A }),
    { state: "current" },
  );
});

test("an absent running id never turns a current pin into a fault", () => {
  // `--stack` is optional; the pin-vs-published question needs no EC2
  // permission, so a caller without one must still get a usable answer.
  for (const running of [null, undefined]) {
    assert.deepEqual(amiPinStatus({ pinned: AMI_A, latest: AMI_A, running }), {
      state: "current",
    });
  }
});

test("a behind pin wins over an instance check — the roll subsumes it", () => {
  const v = amiPinStatus({ pinned: AMI_B, latest: AMI_A, running: AMI_B });
  assert.equal(v.state, "behind");
});

test("every verdict renders one actionable sentence", () => {
  const unknown = amiPinStatus({ pinned: AMI_A, latest: null });
  const verdicts = [
    amiPinStatus({ pinned: AMI_A, latest: AMI_A }),
    amiPinStatus({ pinned: AMI_B, latest: AMI_A }),
    amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_B }),
    unknown,
  ];
  for (const v of verdicts) {
    const line = describeVerdict(v, PINNED_AMI_ID);
    assert.ok(line.length > 20, `verdict ${v.state} must say something`);
    assert.ok(!line.includes("undefined"), `verdict ${v.state} leaked undefined`);
  }
  // The failure text must not read like an all-clear.
  assert.match(describeVerdict(unknown, PINNED_AMI_ID), /NOT "up to date"/);
});

test("the pin is measured against the parameter it was taken from", () => {
  // `-kernel-default-` follows whatever kernel AL2023 currently defaults to;
  // `-kernel-6.1-` is frozen on that line. They agree today and will diverge
  // the day AL2023 moves its default — and comparing against the wrong one
  // would then report an "upgrade available" that no bump can ever satisfy.
  assert.match(AL2023_SSM_PARAMETER, /al2023-ami-kernel-6\.1-arm64$/);
  assert.match(PINNED_AMI_ID, /^ami-[0-9a-f]{8,17}$/);
  assert.equal(PINNED_AMI_REGION, "eu-west-1");
});
