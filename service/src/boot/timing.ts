// How long this VM took to start serving, phase by phase (t_vm_boot_slim).
//
// The VM is a singleton by design, so it is replaced by being killed and
// relaunched, and that window is a total outage for every org. Measured on the
// 2026-09-18 AMI roll, from outside: the ASG issued the launch at 20:06:05 and
// the first request was answered at 20:06:52 — 47 s. What those 47 s were SPENT
// on could not be answered at all: the VM ships no logs to CloudWatch, so
// `boot-restore-complete` and the `ready` line are written to a disk nobody
// reads, on an instance that is usually gone by the time the question is asked.
//
// Optimising before measuring would be guessing at which of the boot's parts is
// worth attacking — the bootstrap's downloads, the node/litestream unpacking, or
// the restore of every active app. So this publishes the split through the one
// channel that already exists and outlives the instance: the CloudWatch metrics
// the heartbeat next door already uses (same namespace, same client, same IAM,
// no new infrastructure).
//
// It is an INSTRUMENT, never a gate: every failure here is swallowed. A boot
// that cannot publish its own timing is still a boot.
import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from "@aws-sdk/client-cloudwatch";
import { metricDimensions, type Dimension } from "../metric-dimensions.ts";
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";

export const METRIC_NAMESPACE = "Dilaya/SqliteData";
export const METRIC_BOOT_SECONDS = "BootSeconds";

/**
 * Seconds since the KERNEL started, read at the moment we begin serving.
 *
 * This is the half that our own code cannot shorten, and therefore the one that
 * decides whether shortening the rest is worth anything: it covers the machine
 * coming up and the whole user-data bootstrap (SSM lookup, artifact download,
 * unpacking node + litestream) before this process even existed. Subtract the
 * service's own total from it and what remains is the floor.
 *
 * Null rather than throwing on a host without /proc — this file is unit-tested
 * on macOS, where it does not exist.
 */
export function readSystemUptimeSeconds(procRoot = "/proc"): number | null {
  try {
    const raw = readFileSync(`${procRoot}/uptime`, "utf8");
    const seconds = Number.parseFloat(raw.split(/\s+/)[0] ?? "");
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

export interface BootPhase {
  phase: string;
  seconds: number;
}

/** Records how long each phase of the boot took, in order. */
export class BootTimer {
  private readonly startedAt: number;
  private lastMark: number;
  private readonly phases: BootPhase[] = [];

  constructor(now = Date.now()) {
    this.startedAt = now;
    this.lastMark = now;
  }

  /** Close the phase that ends here, naming it. */
  mark(phase: string, now = Date.now()): void {
    this.phases.push({ phase, seconds: (now - this.lastMark) / 1000 });
    this.lastMark = now;
  }

  /** Every phase plus `total` (the service's own boot) and, when the host can
   *  tell us, `machine` — kernel start to serving. */
  report(opts: { now?: number; procRoot?: string } = {}): BootPhase[] {
    const now = opts.now ?? Date.now();
    const out = [...this.phases, { phase: "total", seconds: (now - this.startedAt) / 1000 }];
    const machine = readSystemUptimeSeconds(opts.procRoot ?? "/proc");
    if (machine !== null) out.push({ phase: "machine", seconds: machine });
    return out;
  }
}

function toMetricData(report: BootPhase[], dimensions: Dimension[]): MetricDatum[] {
  return report.map(({ phase, seconds }) => ({
    MetricName: METRIC_BOOT_SECONDS,
    Dimensions: [...dimensions, { Name: "phase", Value: phase }],
    Unit: "Seconds" as const,
    Value: seconds,
  }));
}

/**
 * Log the split and publish it. Called once, from the boot, after the API is
 * reachable — publishing EARLIER would put a network round-trip on the path of
 * the very thing being measured.
 */
export async function publishBootTiming(
  cfg: Config,
  timer: BootTimer,
  deps: { client?: CloudWatchClient; procRoot?: string; now?: number } = {},
): Promise<void> {
  const report = timer.report({ now: deps.now, procRoot: deps.procRoot });
  const byPhase: Record<string, number> = {};
  for (const { phase, seconds } of report) byPhase[phase] = Math.round(seconds * 1000) / 1000;
  console.log(JSON.stringify({ type: "boot-timing", ...byPhase }));
  try {
    const client = deps.client ?? new CloudWatchClient({ region: cfg.awsRegion });
    await client.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: toMetricData(report, metricDimensions(cfg)),
      }),
    );
  } catch (err) {
    console.error(JSON.stringify({ type: "boot-timing-publish-failed", message: (err as Error).message }));
  }
}
