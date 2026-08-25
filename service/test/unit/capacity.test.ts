// Capacity sampling. These tests exist because the numbers they read are the
// ones that decide how many apps can be sold: litestream holds ~1 MB of RSS per
// database and the default VM has 916 MB, so memory — not the invoice — is the
// real ceiling. A probe that silently returned nothing would put us back where
// we were on 2026-08-24: the only way to know was an SSM session and `ps`.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  diskSpaceFrom,
  readDiskSpace,
  readMemoryAvailableBytes,
  readProcessRssBytes,
  sampleCapacity,
} from "../../src/capacity.ts";

/** A throwaway /proc: these files cannot be faked by monkey-patching fs. */
function fakeProc(opts: { pid?: number; vmRss?: string; meminfo?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  if (opts.pid !== undefined) {
    mkdirSync(join(root, String(opts.pid)));
    writeFileSync(
      join(root, String(opts.pid), "status"),
      `Name:\tlitestream\nState:\tS (sleeping)\nVmPeak:\t  123456 kB\n${opts.vmRss ?? "VmRSS:\t   56996 kB"}\nThreads:\t14\n`,
    );
  }
  if (opts.meminfo !== undefined) writeFileSync(join(root, "meminfo"), opts.meminfo);
  return root;
}

const MEMINFO = "MemTotal:         938000 kB\nMemFree:           50000 kB\nMemAvailable:     563000 kB\nBuffers:            1000 kB\n";

test("reads VmRSS and converts kB to bytes", () => {
  const root = fakeProc({ pid: 42 });
  assert.equal(readProcessRssBytes(42, root), 56996 * 1024);
});

test("reads MemAvailable, not MemFree", () => {
  const root = fakeProc({ meminfo: MEMINFO });
  // MemFree (50000 kB) is the wrong number on any healthy Linux box — the page
  // cache makes it look alarming while plenty is actually allocatable.
  assert.equal(readMemoryAvailableBytes(root), 563000 * 1024);
});

test("a vanished process yields null, never a throw", () => {
  // A bounce is ~1s during which the pid we just read no longer exists. The
  // metrics probe must not be the thing that takes the service down.
  const root = fakeProc({ meminfo: MEMINFO });
  assert.equal(readProcessRssBytes(99999, root), null);
});

test("an unreadable or malformed /proc yields null, never a throw", () => {
  const root = fakeProc({ pid: 7, vmRss: "VmSize:\t  999 kB" }); // no VmRSS line
  assert.equal(readProcessRssBytes(7, root), null);
  assert.equal(readMemoryAvailableBytes(root), null); // no meminfo at all
  assert.equal(readMemoryAvailableBytes("/nonexistent-proc-root"), null);
});

test("sampleCapacity tolerates litestream not running", () => {
  const root = fakeProc({ meminfo: MEMINFO });
  const sample = sampleCapacity(null, root);
  assert.equal(sample.litestreamRssBytes, null);
  // The box's memory is still reported: the moment litestream is down is not a
  // moment to stop reporting how much room is left.
  assert.equal(sample.memoryAvailableBytes, 563000 * 1024);
});

test("sampleCapacity reports both when both are readable", () => {
  const root = fakeProc({ pid: 1234, meminfo: MEMINFO });
  assert.deepEqual(sampleCapacity(1234, root), {
    litestreamRssBytes: 56996 * 1024,
    memoryAvailableBytes: 563000 * 1024,
    // No path asked for, no disk reading invented.
    disk: null,
  });
});

// --- Disk: the third resource, and the only one eviction never gives back ---
// A full volume is SQLITE_FULL on every org's writes at once, while every other
// instrument stays green. These tests pin the arithmetic, because that is the
// half that can be silently wrong: a probe reporting plenty of room on a full
// disk fails in exactly the direction nobody would notice.

test("disk arithmetic: bytes and percent from blocks", () => {
  // 1000 blocks of 4096 = 4 MB, 250 available = 1 MB free, 75% used.
  assert.deepEqual(diskSpaceFrom({ bsize: 4096, blocks: 1000, bavail: 250 }), {
    diskAvailableBytes: 250 * 4096,
    diskTotalBytes: 1000 * 4096,
    diskUsedPercent: 75,
  });
});

test("a full disk reads as full, not as an error", () => {
  const sample = diskSpaceFrom({ bsize: 4096, blocks: 1000, bavail: 0 });
  assert.equal(sample?.diskAvailableBytes, 0);
  assert.equal(sample?.diskUsedPercent, 100);
});

test("an impossible statfs yields null rather than a fabricated 100%", () => {
  // Without this guard a zero block count divides by zero and publishes NaN, and
  // a zero block size publishes "0 bytes free, 100% used" — i.e. pages someone
  // at 3am for a division that never happened.
  assert.equal(diskSpaceFrom({ bsize: 0, blocks: 1000, bavail: 10 }), null);
  assert.equal(diskSpaceFrom({ bsize: 4096, blocks: 0, bavail: 0 }), null);
  assert.equal(diskSpaceFrom({ bsize: 4096, blocks: 1000, bavail: -1 }), null);
  assert.equal(diskSpaceFrom({ bsize: Number.NaN, blocks: 1000, bavail: 10 }), null);
});

test("readDiskSpace reads a real filesystem, and null for a missing path", () => {
  const here = readDiskSpace(tmpdir());
  assert.notEqual(here, null);
  assert.ok(here!.diskTotalBytes > 0);
  assert.ok(here!.diskAvailableBytes >= 0);
  assert.ok(here!.diskUsedPercent >= 0 && here!.diskUsedPercent <= 100);
  // Boot samples this before the database directory is guaranteed to exist.
  assert.equal(readDiskSpace(join(tmpdir(), "no-such-dir-3f9a2")), null);
});

test("sampleCapacity reports the disk only when asked for a path", () => {
  const root = fakeProc({ pid: 1234, meminfo: MEMINFO });
  const sample = sampleCapacity(1234, root, tmpdir());
  assert.notEqual(sample.disk, null);
  assert.ok(sample.disk!.diskTotalBytes > 0);
});
