// The boot must be able to SAY how long each of its phases took
// (t_vm_boot_slim).
//
// Measured from outside on the 2026-09-18 AMI roll: 47 s between the ASG
// issuing the launch and the first request being answered. What those seconds
// were spent on was unanswerable — the VM ships no logs to CloudWatch, so the
// existing `boot-restore-complete` and `ready` lines are written to a disk
// nobody reads on an instance that is then thrown away.
//
// Two properties are pinned here, and they are the ones that make the numbers
// usable rather than merely present: the phases must SPLIT the boot (each one
// measures its own leg, not the elapsed total, or the biggest number would
// always be the last), and the instrument must never be able to fail a boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootTimer, publishBootTiming, readSystemUptimeSeconds, METRIC_NAMESPACE } from "../service/src/boot/timing.ts";
import type { Config } from "../service/src/config.ts";

const cfg = { awsRegion: "eu-west-1", heartbeatDimension: "dilaya-sqlite-data" } as Config;

/** A /proc that exists, on a machine that may not have one. */
function fakeProc(uptime: string): string {
  const dir = mkdtempSync(join(tmpdir(), "boot-timing-"));
  writeFileSync(join(dir, "uptime"), uptime);
  return dir;
}

test("each phase measures its OWN leg, not the elapsed total", () => {
  const t = new BootTimer(1_000);
  t.mark("vec", 1_500); // 0.5 s
  t.mark("restore", 21_500); // 20 s
  t.mark("register", 22_000); // 0.5 s
  const report = t.report({ now: 22_000, procRoot: "/nonexistent" });
  const by = Object.fromEntries(report.map((p) => [p.phase, p.seconds]));
  assert.equal(by.vec, 0.5);
  assert.equal(by.restore, 20);
  assert.equal(by.register, 0.5);
  // `total` is the service's own boot, so the legs must add up to it.
  assert.equal(by.total, 21);
  assert.equal(by.vec + by.restore + by.register, by.total);
});

test("the machine's own start-up is reported alongside, since we cannot shorten it", () => {
  const t = new BootTimer(0);
  t.mark("restore", 20_000);
  const report = t.report({ now: 20_000, procRoot: fakeProc("41.87 160.16\n") });
  const by = Object.fromEntries(report.map((p) => [p.phase, p.seconds]));
  // 41.87 s of machine for 20 s of service = the floor is the bigger half, and
  // that ratio is the whole reason the number is published.
  assert.equal(by.machine, 41.87);
  assert.equal(by.total, 20);
});

test("no /proc (or an unreadable one) drops that datapoint, never the report", () => {
  assert.equal(readSystemUptimeSeconds("/nonexistent"), null);
  assert.equal(readSystemUptimeSeconds(fakeProc("not a number\n")), null);
  const report = new BootTimer(0).report({ now: 1_000, procRoot: "/nonexistent" });
  assert.deepEqual(report.map((p) => p.phase), ["total"]);
});

test("publishing uses the ONE namespace the instance role is allowed to write", async () => {
  const sent: unknown[] = [];
  const t = new BootTimer(0);
  t.mark("restore", 5_000);
  await publishBootTiming(cfg, t, {
    now: 5_000,
    procRoot: "/nonexistent",
    client: { send: async (cmd: { input: unknown }) => void sent.push(cmd.input) } as never,
  });
  const input = sent[0] as { Namespace: string; MetricData: { Dimensions: { Name: string; Value: string }[] }[] };
  // instance-role.ts grants cloudwatch:PutMetricData under a StringEquals
  // condition on this exact namespace — publishing anywhere else is silently
  // refused by IAM, which would look like a metric that simply never appears.
  assert.equal(input.Namespace, METRIC_NAMESPACE);
  assert.equal(input.Namespace, "Dilaya/SqliteData");
  const phases = input.MetricData.map((d) => d.Dimensions.find((x) => x.Name === "phase")?.Value);
  assert.deepEqual(phases, ["restore", "total"]);
});

test("a publish that throws never reaches the caller — a boot is not an instrument", async () => {
  const t = new BootTimer(0);
  t.mark("restore", 1_000);
  await publishBootTiming(cfg, t, {
    now: 1_000,
    procRoot: "/nonexistent",
    client: {
      send: async () => {
        throw new Error("cloudwatch unreachable");
      },
    } as never,
  });
  // Reaching here IS the assertion: publishBootTiming resolved instead of
  // rejecting, so `void publishBootTiming(...)` in the boot cannot produce an
  // unhandled rejection on a VM whose metrics endpoint is unreachable.
  assert.ok(true);
});
