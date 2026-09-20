// VM→VM relay (t_dbmove_p3_relay_cells).
//
// Every cell sits behind the SAME gateway, which knows nothing about apps: a
// request lands on any cell. The one that does not hold the app forwards it to
// the one that does, over the private network, and hands the answer back
// verbatim. Clients keep one URL, one IAM grant, one retry policy — the 421 of
// placement.ts becomes a detail between VMs.
//
// Two rules carry the safety:
//
// 1. A RELAYED REQUEST IS NEVER RELAYED AGAIN. It carries RELAY_HEADER; a cell
//    that does not hold it answers 421 to the relaying peer. Two cells with
//    diverging caches therefore cost one extra hop, never a loop.
// 2. WHAT THE CLIENT IS TOLD MUST BE TRUE OF WHAT RAN. Its retry policy replays
//    a write on 503 because 503 means "nothing ran". So a failure is only
//    reported UNAVAILABLE when the connection was never established; anything
//    after that may have run on the peer and is an INTERNAL, which is not
//    replayed (dilaya-connector/src/dataapi-retry.ts).
import { request } from "node:http";
import { ServiceError } from "./errors.ts";
import type { PeerLookup, VmRow } from "./vms.ts";

/** Marks a request forwarded by a peer; its value is the relaying cell. */
export const RELAY_HEADER = "x-dilaya-relayed";

export interface RelayRequest {
  method: string;
  /** Path and query string, as received. */
  path: string;
  capHeader?: string;
  /** The JSON body, already serialized; absent for GET. */
  body?: string;
}

export interface RelayedResponse {
  status: number;
  body: string;
}

/**
 * The only failure that proves the peer never saw the request: the TCP
 * connection was not established. Judged from the socket, not from an error
 * code list — a list is a guess about what a dead host looks like, and a dead
 * instance sends no RST at all: it just never answers the SYN.
 */
export class NeverConnectedError extends Error {}

export type Sender = (target: VmRow, req: RelayRequest, headers: Record<string, string>, opts: SendOpts) => Promise<RelayedResponse>;
export interface SendOpts {
  connectTimeoutMs: number;
  timeoutMs: number;
}

export const httpSender: Sender = (target, req, headers, opts) =>
  new Promise((resolve, reject) => {
    let connected = false;
    const out = request(
      { host: target.ip, port: target.port, path: req.path, method: req.method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    const connectTimer = setTimeout(() => out.destroy(new Error("connect timed out")), opts.connectTimeoutMs);
    out.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });
    out.setTimeout(opts.timeoutMs, () => out.destroy(new Error("relay timed out")));
    out.on("error", (err) => {
      clearTimeout(connectTimer);
      reject(connected ? err : new NeverConnectedError(err.message));
    });
    out.end(req.body);
  });

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "relay", ...event }));
}

export class Relay {
  private readonly cellId: string;
  private readonly peers: PeerLookup;
  private readonly sendOpts: SendOpts;
  private readonly sender: Sender;

  constructor(opts: { cellId: string; peers: PeerLookup; timeoutMs: number; connectTimeoutMs?: number; sender?: Sender }) {
    this.cellId = opts.cellId;
    this.peers = opts.peers;
    this.sendOpts = { timeoutMs: opts.timeoutMs, connectTimeoutMs: opts.connectTimeoutMs ?? 2_000 };
    this.sender = opts.sender ?? httpSender;
  }

  async forward(toCell: string, req: RelayRequest): Promise<RelayedResponse> {
    let targets = await this.peers.targets(toCell);
    if (targets.length === 0) {
      // A cell that just rolled is announced under a new instance id.
      this.peers.reload();
      targets = await this.peers.targets(toCell);
    }
    for (const target of targets) {
      try {
        const res = await this.send(target, req);
        // A draining peer answers 503: its successor is announced under a new
        // id, which the next request should find without waiting for the cache.
        if (res.status === 503) this.peers.reload();
        return res;
      } catch (err) {
        const message = (err as Error).message;
        if (!(err instanceof NeverConnectedError)) {
          log({ event: "failed-after-connect", toCell, instanceId: target.instanceId, message });
          throw new ServiceError("INTERNAL", `relay to cell ${toCell} failed after the request was sent: ${message}`);
        }
        // Nothing ran there: the next instance of the cell is a fair try.
        log({ event: "never-connected", toCell, instanceId: target.instanceId, message });
      }
    }
    this.peers.reload();
    throw new ServiceError("UNAVAILABLE", `cell ${toCell} has no reachable instance; retry shortly`);
  }

  /**
   * The same request to every instance of every OTHER cell — for what has no
   * holder, i.e. `/admin/sync`. Found by the two-cell trial: a placement row
   * followed by a sync reached ONE cell; the other kept its cache for 30 s,
   * still believed the app was its own, and created the database at home.
   * Best effort by nature (a cell may be rolling): the caller gets the list.
   */
  async broadcast(req: RelayRequest): Promise<{ cellId: string; instanceId: string; status: number }[]> {
    const targets = await this.peers.others(this.cellId);
    return Promise.all(
      targets.map(async ({ cellId, instanceId, ...rest }) => {
        const status = await this.send({ cellId, instanceId, ...rest }, req).then((r) => r.status, () => 0);
        if (status !== 200) log({ event: "broadcast-failed", path: req.path, cellId, instanceId, status });
        return { cellId, instanceId, status };
      }),
    );
  }

  private send(target: VmRow, req: RelayRequest): Promise<RelayedResponse> {
    const headers: Record<string, string> = { [RELAY_HEADER]: this.cellId };
    if (req.capHeader !== undefined) headers["x-dilaya-capability"] = req.capHeader;
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(req.body));
    }
    return this.sender(target, req, headers, this.sendOpts);
  }
}
