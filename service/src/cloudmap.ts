// Cloud Map self-registration: the API Gateway VPC Link discovers the instance
// through a service-discovery service; each instance registers its own private
// IP at boot and deregisters on drain.
//
// A crashed predecessor never deregisters, so the boot also clears what it left
// behind — but only IN ITS OWN CELL (t_dbmove_p2_placement). This used to be
// "deregister everyone, then register me", safe only while the ASG guaranteed a
// single live instance: with a second cell, each boot would have evicted the
// other cell from discovery. Registrations carry their cell as an attribute;
// one without it predates this and belongs to the origin cell.
import { ORIGIN_CELL } from "./placement.ts";
import {
  DeregisterInstanceCommand,
  ListInstancesCommand,
  RegisterInstanceCommand,
  ServiceDiscoveryClient,
} from "@aws-sdk/client-servicediscovery";

const IMDS_BASE = "http://169.254.169.254";
export const CELL_ATTRIBUTE = "DILAYA_CELL";

/** Whether a registration found at boot is this cell's to clear. */
export function isStaleOfCell(attributes: Record<string, string> | undefined, cellId: string): boolean {
  return (attributes?.[CELL_ATTRIBUTE] ?? ORIGIN_CELL) === cellId;
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "cloudmap", ...event }));
}

async function imds(path: string): Promise<string> {
  const tokenRes = await fetch(`${IMDS_BASE}/latest/api/token`, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
    signal: AbortSignal.timeout(3000),
  });
  if (!tokenRes.ok) throw new Error(`IMDS token failed: ${tokenRes.status}`);
  const token = await tokenRes.text();
  const res = await fetch(`${IMDS_BASE}${path}`, {
    headers: { "X-aws-ec2-metadata-token": token },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`IMDS ${path} failed: ${res.status}`);
  return res.text();
}

export class CloudMapRegistration {
  private readonly client: ServiceDiscoveryClient;
  private readonly serviceId: string;
  private readonly port: number;
  private readonly cellId: string;
  private instanceId: string | null = null;
  private ip: string | null = null;

  constructor(opts: {
    serviceId: string;
    region: string;
    port: number;
    cellId?: string;
    client?: ServiceDiscoveryClient;
    /** Test seam: the instance's own id and private IP, instead of IMDS. */
    identity?: () => Promise<[instanceId: string, ip: string]>;
  }) {
    this.serviceId = opts.serviceId;
    this.cellId = opts.cellId ?? ORIGIN_CELL;
    if (opts.identity) this.identity = opts.identity;
    this.port = opts.port;
    this.client = opts.client ?? new ServiceDiscoveryClient({ region: opts.region });
  }

  private identity = (): Promise<[string, string]> =>
    Promise.all([imds("/latest/meta-data/instance-id"), imds("/latest/meta-data/local-ipv4")]);

  /** Boot: clear this cell's stale registrations, then register this instance. */
  async register(): Promise<void> {
    const [instanceId, ip] = await this.identity();

    const existing = await this.client.send(new ListInstancesCommand({ ServiceId: this.serviceId }));
    for (const inst of existing.Instances ?? []) {
      if (!inst.Id || !isStaleOfCell(inst.Attributes, this.cellId)) continue;
      try {
        await this.client.send(new DeregisterInstanceCommand({ ServiceId: this.serviceId, InstanceId: inst.Id }));
        log({ event: "deregistered-stale", instanceId: inst.Id });
      } catch (err) {
        log({ event: "deregister-stale-failed", instanceId: inst.Id, message: (err as Error).message });
      }
    }

    this.instanceId = instanceId;
    this.ip = ip;
    await this.registerSelf();
  }

  /** Who registered, for the `_vms` row (vms.ts). Null before `register()`. */
  get registered(): { instanceId: string; ip: string; port: number; cellId: string } | null {
    if (!this.instanceId || !this.ip) return null;
    return { instanceId: this.instanceId, ip: this.ip, port: this.port, cellId: this.cellId };
  }

  /** Register WITHOUT clearing anything — also how an instance a peer wrongly evicted comes back. */
  async registerSelf(): Promise<void> {
    if (!this.instanceId || !this.ip) return;
    await this.client.send(
      new RegisterInstanceCommand({
        ServiceId: this.serviceId,
        InstanceId: this.instanceId,
        Attributes: {
          AWS_INSTANCE_IPV4: this.ip,
          AWS_INSTANCE_PORT: String(this.port),
          [CELL_ATTRIBUTE]: this.cellId,
        },
      }),
    );
    log({ event: "registered", instanceId: this.instanceId, ip: this.ip, port: this.port });
  }

  /** A peer that died without deregistering (peer-watch.ts). */
  async deregisterPeer(instanceId: string): Promise<void> {
    await this.client.send(new DeregisterInstanceCommand({ ServiceId: this.serviceId, InstanceId: instanceId }));
    log({ event: "deregistered-dead-peer", instanceId });
  }

  /** Drain: pull this instance out of discovery before the API stops answering. */
  async deregister(): Promise<void> {
    if (!this.instanceId) return;
    try {
      await this.client.send(
        new DeregisterInstanceCommand({ ServiceId: this.serviceId, InstanceId: this.instanceId }),
      );
      log({ event: "deregistered", instanceId: this.instanceId });
    } catch (err) {
      log({ event: "deregister-failed", message: (err as Error).message });
    }
    this.instanceId = null;
  }
}
