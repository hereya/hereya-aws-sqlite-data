// What makes this instance one cell AMONG several (t_dbmove_p3_relay_cells):
// the relay towards the other cells, the Cloud Map registration, and the
// `_vms` row that tells peers where this cell answers.
import { CloudMapRegistration } from "../cloudmap.ts";
import type { Config } from "../config.ts";
import { PeerWatch } from "../peer-watch.ts";
import { Relay } from "../relay.ts";
import { VmDirectory } from "../vms.ts";

/** Just under API Gateway's 30 s integration timeout: past it nobody is listening. */
const RELAY_TIMEOUT_MS = 29_000;
/** Three still ticks = a peer is evicted after about a minute of silence. */
const PEER_WATCH_MS = 20_000;

export interface Cells {
  /** Null in file (local-dev) mode: no table, so no directory to find a peer in. */
  relay: Relay | null;
  /** Boot step 6: enter discovery, then tell the peers. */
  join(port: number): Promise<{ cloudMap: CloudMapRegistration | null; peerWatch: PeerWatch | null }>;
}

export function createCells(cfg: Config): Cells {
  const directory =
    cfg.registryMode === "ddb" && cfg.registryTable
      ? new VmDirectory({ tableName: cfg.registryTable, region: cfg.awsRegion, cacheMs: cfg.registryCacheMs })
      : null;
  const relay = directory ? new Relay({ cellId: cfg.cellId, peers: directory, timeoutMs: RELAY_TIMEOUT_MS }) : null;

  async function join(port: number): Promise<{ cloudMap: CloudMapRegistration | null; peerWatch: PeerWatch | null }> {
    if (!cfg.cloudMapServiceId) return { cloudMap: null, peerWatch: null };
    const cloudMap = new CloudMapRegistration({
      serviceId: cfg.cloudMapServiceId,
      region: cfg.awsRegion,
      port,
      cellId: cfg.cellId,
    });
    await cloudMap.register();
    const self = cloudMap.registered;
    if (!directory || !self) return { cloudMap, peerWatch: null };
    const peerWatch = new PeerWatch({
      directory,
      self,
      deregisterPeer: (instanceId) => cloudMap.deregisterPeer(instanceId),
      registerSelf: () => cloudMap.registerSelf(),
    });
    // ⚠️ Never fatal. With ONE cell nobody reads this row, and a boot that
    // aborts here is a total outage of every org's databases over a row that
    // only matters to a second cell. The tick rewrites it every 20 s.
    try {
      await peerWatch.announce();
    } catch (err) {
      console.error(JSON.stringify({ type: "peer-watch", event: "announce-failed", message: (err as Error).message }));
    }
    peerWatch.start(PEER_WATCH_MS);
    return { cloudMap, peerWatch };
  }

  return { relay, join };
}
