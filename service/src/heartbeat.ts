// Dead-man switch: the service emits a CloudWatch metric only while it is
// genuinely healthy end-to-end (HTTP up AND litestream replicating). Silence —
// instance dead, service wedged, replication down, network cut — trips the
// missing-data alarm, which relays to Telegram. « Le silence est interdit. »
import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from "@aws-sdk/client-cloudwatch";
import type { Config } from "./config.ts";
import { sampleCapacity } from "./capacity.ts";

export const METRIC_NAMESPACE = "Dilaya/SqliteData";
export const METRIC_NAME = "Heartbeat";
/** Capacity metrics — see capacity.ts for why they are published raw. */
export const METRIC_LITESTREAM_RSS = "LitestreamRssBytes";
export const METRIC_MEMORY_AVAILABLE = "MemoryAvailableBytes";
export const METRIC_SERVED_APPS = "ServedApps";

export interface CapacitySource {
  /** Pid of the litestream process, or null when none is running. */
  litestreamPid: () => number | null;
  /** How many app databases this instance is currently serving. */
  servedApps: () => number;
  /** Where to read /proc from. Injectable so the publishing path can be tested
   *  against a fixture instead of the host's real /proc — which does not exist
   *  on macOS, where these tests are usually run. */
  procRoot?: string;
}

export class Heartbeat {
  private readonly cfg: Config;
  private readonly client: CloudWatchClient;
  private readonly isHealthy: () => boolean;
  private readonly capacity: CapacitySource | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    cfg: Config,
    isHealthy: () => boolean,
    client?: CloudWatchClient,
    capacity?: CapacitySource,
  ) {
    this.cfg = cfg;
    this.isHealthy = isHealthy;
    this.client = client ?? new CloudWatchClient({ region: cfg.awsRegion });
    this.capacity = capacity ?? null;
  }

  /**
   * Capacity datapoints for this tick.
   *
   * These are deliberately NOT gated on health, unlike the Heartbeat datum: the
   * moment the memory reading matters most is precisely the moment the service
   * is struggling, and a probe that goes quiet under pressure would hide the one
   * event it exists to catch. A missing /proc read drops that single datapoint
   * rather than the whole tick.
   */
  private capacityData(): MetricDatum[] {
    if (this.capacity === null) return [];
    const dimensions = [{ Name: "stack", Value: this.cfg.heartbeatDimension }];
    const data: MetricDatum[] = [];
    const sample = sampleCapacity(this.capacity.litestreamPid(), this.capacity.procRoot);
    if (sample.litestreamRssBytes !== null) {
      data.push({
        MetricName: METRIC_LITESTREAM_RSS,
        Dimensions: dimensions,
        Unit: "Bytes",
        Value: sample.litestreamRssBytes,
      });
    }
    if (sample.memoryAvailableBytes !== null) {
      data.push({
        MetricName: METRIC_MEMORY_AVAILABLE,
        Dimensions: dimensions,
        Unit: "Bytes",
        Value: sample.memoryAvailableBytes,
      });
    }
    data.push({
      MetricName: METRIC_SERVED_APPS,
      Dimensions: dimensions,
      Unit: "Count",
      Value: this.capacity.servedApps(),
    });
    return data;
  }

  start(): void {
    if (!this.cfg.heartbeatEnabled) return;
    const beat = async (): Promise<void> => {
      // One call per tick carries both concerns: the dead-man Heartbeat datum
      // (present ONLY when healthy — that absence is the whole alarm) and the
      // capacity data (always). Same client, same timer, same IAM.
      const healthy = this.isHealthy();
      if (!healthy) {
        console.log(JSON.stringify({ type: "heartbeat", skipped: true, reason: "unhealthy" }));
      }
      const metricData: MetricDatum[] = this.capacityData();
      if (healthy) {
        metricData.push({
          MetricName: METRIC_NAME,
          Dimensions: [{ Name: "stack", Value: this.cfg.heartbeatDimension }],
          Value: 1,
        });
      }
      if (metricData.length === 0) return;
      try {
        await this.client.send(
          new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: metricData }),
        );
      } catch (err) {
        // do not crash on a metrics hiccup; sustained failure = alarm fires anyway
        console.error(JSON.stringify({ type: "heartbeat", error: (err as Error).message }));
      }
    };
    void beat();
    this.timer = setInterval(() => void beat(), this.cfg.heartbeatPeriodSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
