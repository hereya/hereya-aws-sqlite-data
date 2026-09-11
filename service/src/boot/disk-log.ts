import { readDiskSpace } from "../capacity.ts";

/**
 * Announce the volume once, at boot. The metric next door answers "is it
 * filling up"; this line answers the question asked at the other end — "how
 * many apps does this machine hold" — which needs the SIZE, and a size does
 * not belong in a per-minute series. Before it existed the only way to know
 * was an SSM session and `df`.
 */
export function logDiskVolume(dbDir: string): void {
  const disk = readDiskSpace(dbDir);
  if (disk !== null) {
    console.log(
      JSON.stringify({
        type: "disk",
        event: "volume",
        path: dbDir,
        totalBytes: disk.diskTotalBytes,
        availableBytes: disk.diskAvailableBytes,
        usedPercent: Math.round(disk.diskUsedPercent * 10) / 10,
      }),
    );
  }
}
