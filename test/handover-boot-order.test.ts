// The boot's ORDER is the handover's safety property, so it is pinned at the
// source (t_vm_zero_cut_handover).
//
// Two orderings carry the whole design, and both are the kind a later tidy-up
// would happily "simplify" — each looks like a harmless move and neither
// changes any test that exercises behaviour, because with the flag off the
// code does not run at all:
//
//   1. `announceWarming` BEFORE `bootRestoreAll`. The announcement opens the
//      window whose writes the departing instance reports. The restore takes
//      ~21.5 s on the measured fleet, and a write landing inside it is exactly
//      the one our freshly-restored copy missed. Announce after the restore and
//      those writes are outside our copy AND outside the catch-up list: stale
//      data, silently. This was a REAL bug in the first wiring, found on the
//      final review before merge.
//
//   2. `runHandoverGate` BEFORE `litestream.start`. Replicating before the
//      predecessor has proved it stopped is the dual-writer that the ASG's
//      terminate-before-launch exists to prevent.
//
// A behavioural test cannot catch either: with `HANDOVER_ENABLED` absent — the
// default, and how the package ships — neither call executes. So this reads the
// file, which is blunt but is the only thing that actually guards it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../service/src/boot/service.ts", import.meta.url), "utf8");

function indexOfOrFail(needle: string): number {
  const at = src.indexOf(needle);
  assert.notEqual(at, -1, `boot/service.ts no longer contains \`${needle}\` — this guard needs updating, not deleting`);
  return at;
}

test("the warm-up is announced BEFORE the restore, or the catch-up list has a hole", () => {
  assert.ok(
    indexOfOrFail("announceWarming(") < indexOfOrFail("sync.bootRestoreAll()"),
    "announceWarming must run before bootRestoreAll: writes landing during the restore would otherwise be missing from our copy AND from the dirty list",
  );
});

test("the handover gate runs BEFORE replication starts, or two writers overlap", () => {
  assert.ok(
    indexOfOrFail("runHandoverGate(") < indexOfOrFail("litestream.start("),
    "runHandoverGate must run before litestream.start: replicating before the predecessor proved it stopped is the dual-writer",
  );
});

test("…and the gate runs after the port binds, which is what makes the wait free", () => {
  // Binding first costs nothing (Cloud Map has not been told about us, so
  // nothing routes here) and means the moment the handover lands we are one
  // registration away from serving, rather than one more startup step.
  assert.ok(
    indexOfOrFail("server.listen(") < indexOfOrFail("runHandoverGate("),
    "the port should already be bound when the gate waits",
  );
});
