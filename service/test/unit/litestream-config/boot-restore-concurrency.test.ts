// --- boot-restore concurrency (added 2026-08-24 with the parallel restore) ---
// The bound is validated at boot rather than clamped, for the same reason the
// litestream durations are: a silently-corrected value would let us believe we
// had configured something we had not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeLitestream } from "./helpers.ts";

test("BOOT_RESTORE_CONCURRENCY defaults to 8", () => {
  assert.equal(makeLitestream()["cfg"].bootRestoreConcurrency, 8);
});

test("BOOT_RESTORE_CONCURRENCY is validated, not clamped", () => {
  for (const bad of ["0", "65", "-1"]) {
    assert.throws(
      () => makeLitestream({ BOOT_RESTORE_CONCURRENCY: bad }),
      /BOOT_RESTORE_CONCURRENCY/,
      `${bad} must be refused at boot`,
    );
  }
  assert.equal(makeLitestream({ BOOT_RESTORE_CONCURRENCY: "16" })["cfg"].bootRestoreConcurrency, 16);
});
