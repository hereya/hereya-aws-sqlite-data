// The heartbeat now carries two concerns in one call, and they have OPPOSITE
// rules about silence. Getting them backwards would break the alarm that has
// guarded this VM since day one, so each rule gets its own test.
//
//  - Heartbeat: published ONLY when healthy. Its ABSENCE is the alarm
//    (« le silence est interdit »).
//  - Capacity:  published ALWAYS. The moment memory matters most is the moment
//    the service is struggling; a probe that went quiet under pressure would
//    hide the one event it exists to catch.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Heartbeat,
  METRIC_NAME,
  METRIC_LITESTREAM_RSS,
  METRIC_MEMORY_AVAILABLE,
  METRIC_SERVED_APPS,
} from "../../src/heartbeat.ts";
import { loadConfig } from "../../src/config.ts";

function makeCfg() {
  return loadConfig({
    REPLICA_BASE_URL: "file:///replicas",
    HEARTBEAT_ENABLED: "1",
    HEARTBEAT_PERIOD_SECONDS: "3600", // long: we drive the first beat only
  } as NodeJS.ProcessEnv);
}

/** Captures what would have gone to CloudWatch. */
function recordingClient() {
  const calls: { MetricName?: string; Value?: number; Unit?: string }[][] = [];
  const client = {
    send: async (cmd: { input: { MetricData?: { MetricName?: string; Value?: number; Unit?: string }[] } }) => {
      calls.push(cmd.input.MetricData ?? []);
      return {};
    },
  };
  return { client, calls, names: () => calls.flat().map((d) => d.MetricName) };
}

/** A fixture /proc, so this exercises the real publishing path on any OS —
 *  the host's own /proc does not exist on macOS, where these usually run. */
function fakeProc(pid: number | null): string {
  const root = mkdtempSync(join(tmpdir(), "hb-proc-"));
  writeFileSync(join(root, "meminfo"), "MemTotal:  938000 kB\nMemAvailable:  563000 kB\n");
  if (pid !== null) {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "status"), `Name:\tlitestream\nVmRSS:\t   56996 kB\n`);
  }
  return root;
}

async function beatOnce(healthy: boolean, servedApps = 61, pid: number | null = null) {
  const rec = recordingClient();
  const hb = new Heartbeat(makeCfg(), () => healthy, rec.client as never, {
    litestreamPid: () => pid,
    servedApps: () => servedApps,
    procRoot: fakeProc(pid),
  });
  hb.start();
  await new Promise((r) => setTimeout(r, 20));
  hb.stop();
  return rec;
}

test("healthy: one call carries the heartbeat AND the capacity data", async () => {
  const rec = await beatOnce(true);
  assert.equal(rec.calls.length, 1, "both concerns must ride in a single PutMetricData");
  const names = rec.names();
  assert.ok(names.includes(METRIC_NAME), "heartbeat datum must be present when healthy");
  assert.ok(names.includes(METRIC_SERVED_APPS));
  assert.ok(names.includes(METRIC_MEMORY_AVAILABLE));
  const mem = rec.calls.flat().find((d) => d.MetricName === METRIC_MEMORY_AVAILABLE);
  assert.equal(mem?.Value, 563000 * 1024, "MemAvailable must be reported in bytes");
  assert.equal(mem?.Unit, "Bytes");
});

test("litestream RSS is published when the process is up", async () => {
  const rec = await beatOnce(true, 61, 4242);
  const rss = rec.calls.flat().find((d) => d.MetricName === METRIC_LITESTREAM_RSS);
  assert.equal(rss?.Value, 56996 * 1024);
  assert.equal(rss?.Unit, "Bytes");
});

test("unhealthy: the heartbeat datum disappears — that absence IS the alarm", async () => {
  const rec = await beatOnce(false);
  assert.ok(!rec.names().includes(METRIC_NAME), "publishing a heartbeat while unhealthy would defeat the dead-man switch");
});

test("unhealthy: capacity is STILL published", async () => {
  // The regression this guards: gating capacity on health would blind us
  // exactly when the VM is running out of memory.
  const rec = await beatOnce(false);
  const names = rec.names();
  assert.ok(names.includes(METRIC_SERVED_APPS), "served-apps must survive an unhealthy tick");
  assert.ok(names.includes(METRIC_MEMORY_AVAILABLE), "memory must survive an unhealthy tick");
});

test("served apps is reported as the live count, not a constant", async () => {
  const rec = await beatOnce(true, 137);
  const datum = rec.calls.flat().find((d) => d.MetricName === METRIC_SERVED_APPS);
  assert.equal(datum?.Value, 137);
  assert.equal(datum?.Unit, "Count");
});

test("a missing RSS reading drops that datapoint, not the whole tick", async () => {
  // litestream mid-bounce: pid null. Everything else must still be reported.
  const rec = await beatOnce(true);
  const names = rec.names();
  assert.ok(!names.includes(METRIC_LITESTREAM_RSS), "no pid means no RSS datum");
  assert.ok(names.includes(METRIC_SERVED_APPS), "the rest of the tick must survive");
  assert.ok(names.includes(METRIC_NAME));
});

test("capacity is inert when no source is wired (back-compat)", async () => {
  const rec = recordingClient();
  const hb = new Heartbeat(makeCfg(), () => true, rec.client as never);
  hb.start();
  await new Promise((r) => setTimeout(r, 20));
  hb.stop();
  assert.deepEqual(rec.names(), [METRIC_NAME]);
});
