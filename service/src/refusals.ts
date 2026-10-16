// Refused requests leave the VM (t_dataapi_audit_cw, 2026-10-16).
//
// Every request writes one `audit` line to the journal (server/http.ts), and
// that journal never leaves the instance. The gateway's access log knows
// neither the org nor the app — so on 2026-10-03, attributing a spike of 400s
// (284 SQL_ERROR from ONE customer app) took an `ssm send-command` on the
// production VM. This ships the `allowed:false` lines, unchanged, to a
// CloudWatch log group the stack owns, where a sweep reads them with Insights:
//
//   stats count() by code, orgId, appId | sort count() desc
//
// Best effort by contract, like the heartbeat: it can only log, never fail a
// request. The buffer is bounded (a flood of refusals must not grow memory) and
// what is dropped is COUNTED in a `refusals_dropped` line, never silent. A
// failed put loses that batch here; the journal still has every line.
import { hostname } from "node:os";
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { AuditLine } from "./server/http.ts";

/** Per flush window. Far above the worst day seen (248 in 24 h). */
export const MAX_BUFFERED = 1000;

interface LogsClient {
  send(cmd: unknown): Promise<unknown>;
}

export interface RefusalLogOptions {
  logGroup: string;
  cellId: string;
  flushMs: number;
  region?: string;
  client?: LogsClient;
  /** One stream per instance: two instances overlap during a handover. */
  stream?: string;
}

interface LogEvent {
  timestamp: number;
  message: string;
}

export class RefusalLog {
  private readonly opts: RefusalLogOptions;
  private readonly client: LogsClient;
  readonly stream: string;
  private buf: LogEvent[] = [];
  private dropped = 0;
  private streamReady = false;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RefusalLogOptions) {
    this.opts = opts;
    this.client = opts.client ?? (new CloudWatchLogsClient({ region: opts.region }) as LogsClient);
    this.stream = opts.stream ?? `cell-${opts.cellId}/${hostname()}`;
  }

  record(line: AuditLine): void {
    if (line.allowed) return;
    // A relayed request is audited again, with its real code, by the cell
    // that served it: counting the hop too would double every relayed refusal.
    if (line.code?.startsWith("RELAYED_")) return;
    if (this.buf.length >= MAX_BUFFERED) {
      this.dropped++;
      return;
    }
    const ts = Date.parse(line.ts);
    this.buf.push({
      timestamp: Number.isNaN(ts) ? Date.now() : ts,
      message: JSON.stringify({ type: "audit", ...line, cell: this.opts.cellId }),
    });
  }

  /** Ships what is buffered. Never throws; concurrent calls share one put. */
  flush(): Promise<void> {
    this.flushing ??= this.ship().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async ship(): Promise<void> {
    const events = this.buf.splice(0);
    if (this.dropped > 0) {
      events.push({ timestamp: Date.now(), message: JSON.stringify({ type: "refusals_dropped", dropped: this.dropped, cell: this.opts.cellId }) });
      this.dropped = 0;
    }
    if (events.length === 0) return;
    // PutLogEvents refuses a batch that is not in chronological order.
    events.sort((a, b) => a.timestamp - b.timestamp);
    const target = { logGroupName: this.opts.logGroup, logStreamName: this.stream };
    try {
      if (!this.streamReady) {
        await this.client.send(new CreateLogStreamCommand(target)).catch((err: Error) => {
          if (err.name !== "ResourceAlreadyExistsException") throw err;
        });
        this.streamReady = true;
      }
      await this.client.send(new PutLogEventsCommand({ ...target, logEvents: events }));
    } catch (err) {
      // A stream deleted under us is recreated on the next window.
      if ((err as Error).name === "ResourceNotFoundException") this.streamReady = false;
      console.error(JSON.stringify({ type: "refusals", error: (err as Error).message, lost: events.length }));
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    // Lines recorded while an earlier put was in flight.
    if (this.buf.length > 0 || this.dropped > 0) await this.flush();
  }
}
