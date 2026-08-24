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
import { readMemoryAvailableBytes, readProcessRssBytes, sampleCapacity } from "../../src/capacity.ts";

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
  });
});
