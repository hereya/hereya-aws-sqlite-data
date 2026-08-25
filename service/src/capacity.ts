// Capacity telemetry: how much room is left on the database VM.
//
// The heartbeat next door answers "is it alive". This answers the question that
// arrives BEFORE death — "how many more apps fit" — and it is the one nothing
// could answer until now: on 2026-08-24 the only way to know litestream's memory
// was to open an SSM session and run `ps` by hand. Nobody does that at 3am, and
// nobody did it once in the four months this VM has been serving customers.
//
// Why it matters more than the money: the S3 bill at the 10k-app target is ~0.4%
// of revenue, but litestream costs ~1 MB of RSS per database and the default VM
// has 916 MB. The wall is memory, and it arrives several times sooner than any
// invoice does.
//
// Both numbers are published RAW (bytes, and a count) rather than pre-divided:
// the interesting quantity is RSS-per-app, but a ratio computed here would be a
// number nobody can re-derive or re-slice. CloudWatch metric math does the
// division at read time, over whatever window the reader wants.
import { readFileSync, statfsSync } from "node:fs";

export interface CapacitySample {
  /** RSS of the litestream process, in bytes; null when it is not running. */
  litestreamRssBytes: number | null;
  /** MemAvailable for the whole box, in bytes; null if /proc is unreadable. */
  memoryAvailableBytes: number | null;
  /** Free space where the databases live; null when no path was given or it
   *  could not be read. See readDiskSpace below for why this one exists. */
  disk: DiskSample | null;
}

/**
 * VmRSS out of /proc/<pid>/status, in bytes.
 *
 * Deliberately returns null rather than throwing: the process can exit between
 * the pid being read and this call (a bounce is ~1s of exactly that), and a
 * metrics probe must never be the thing that takes the service down.
 */
export function readProcessRssBytes(pid: number, procRoot = "/proc"): number | null {
  try {
    const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) return null;
    return Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

/**
 * MemAvailable out of /proc/meminfo, in bytes.
 *
 * MemAvailable, not MemFree: MemFree looks alarming on any healthy Linux box
 * because the page cache is doing its job. MemAvailable is the kernel's own
 * estimate of what a new allocation could actually get, which is the number a
 * capacity alarm must watch.
 */
export function readMemoryAvailableBytes(procRoot = "/proc"): number | null {
  try {
    const meminfo = readFileSync(`${procRoot}/meminfo`, "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
    if (!match) return null;
    return Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

export function sampleCapacity(
  litestreamPid: number | null,
  procRoot: string = "/proc",
  diskPath?: string,
): CapacitySample {
  return {
    litestreamRssBytes: litestreamPid === null ? null : readProcessRssBytes(litestreamPid, procRoot),
    memoryAvailableBytes: readMemoryAvailableBytes(procRoot),
    disk: diskPath === undefined ? null : readDiskSpace(diskPath),
  };
}

/**
 * Free space on the filesystem holding the databases.
 *
 * The third resource, and the only one eviction can never give back: evicting
 * an app drops it from litestream (a thread, ~0.46 MB of RSS) but deliberately
 * leaves its file on disk, so disk only ever grows. It is also the one whose
 * exhaustion is invisible to every other instrument: a full volume is
 * `SQLITE_FULL` on the writes of every org at once, while the heartbeat still
 * beats, memory is still free, and CloudFront still serves 200s.
 *
 * Split into a pure function over the statfs shape and a thin reader, so the
 * arithmetic — the part that can be wrong — is testable without a filesystem of
 * a given fullness.
 */
export interface DiskSample {
  /** Bytes an unprivileged writer could still use (df's "Avail"). */
  diskAvailableBytes: number;
  /** Size of the whole filesystem, in bytes. */
  diskTotalBytes: number;
  /** 0..100. Reserved-for-root blocks count as USED — the conservative side:
   *  an alarm should read full slightly early, never slightly late. */
  diskUsedPercent: number;
}

interface StatfsLike {
  bsize: number;
  blocks: number;
  bavail: number;
}

export function diskSpaceFrom(stats: StatfsLike): DiskSample | null {
  const { bsize, blocks, bavail } = stats;
  // A zero block size or an empty filesystem is not a reading, it is a bug in
  // the reading. Publishing "0 bytes free, 100% used" from it would page
  // someone at 3am for a division that never happened.
  if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || !Number.isFinite(bavail)) return null;
  if (bsize <= 0 || blocks <= 0 || bavail < 0) return null;
  const diskTotalBytes = blocks * bsize;
  const diskAvailableBytes = bavail * bsize;
  const used = Math.max(0, diskTotalBytes - diskAvailableBytes);
  return {
    diskAvailableBytes,
    diskTotalBytes,
    diskUsedPercent: (used / diskTotalBytes) * 100,
  };
}

/**
 * statfs on the database directory. Null — never a throw — when the path does
 * not exist yet or cannot be read: same contract as the /proc probes next door,
 * for the same reason (a metrics probe must not be what takes the service down,
 * and boot samples this before the directory is guaranteed to exist).
 */
export function readDiskSpace(path: string): DiskSample | null {
  try {
    return diskSpaceFrom(statfsSync(path));
  } catch {
    return null;
  }
}
