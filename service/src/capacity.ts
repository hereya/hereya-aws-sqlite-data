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
import { readFileSync } from "node:fs";

export interface CapacitySample {
  /** RSS of the litestream process, in bytes; null when it is not running. */
  litestreamRssBytes: number | null;
  /** MemAvailable for the whole box, in bytes; null if /proc is unreadable. */
  memoryAvailableBytes: number | null;
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

export function sampleCapacity(litestreamPid: number | null, procRoot: string = "/proc"): CapacitySample {
  return {
    litestreamRssBytes: litestreamPid === null ? null : readProcessRssBytes(litestreamPid, procRoot),
    memoryAvailableBytes: readMemoryAvailableBytes(procRoot),
  };
}
