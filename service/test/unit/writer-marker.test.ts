// The instance remembers, on its own disk, that it WAS the litestream writer —
// so that a restart of its process is not mistaken for a replacement warming up
// (t_handover_stale_ack_wipe).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearWriter, markWriter, wasWriter } from "../../src/handover/writer-marker.ts";

test("a fresh disk was never the writer; a marked one is, until a clean stop releases it", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "writer-")), "dbs");
  assert.equal(wasWriter(dir), false);
  markWriter(dir);
  assert.equal(wasWriter(dir), true);
  assert.equal(clearWriter(dir), true);
  assert.equal(wasWriter(dir), false);
  assert.equal(clearWriter(dir), true, "idempotent");
});

test("the boot skips the replacement's gate for a restarted writer, marks AFTER replication starts, and the shutdown releases BEFORE its report", () => {
  // The ORDER is the safety property, so it is pinned on the source, like
  // handover-boot-order.test.ts does for the gate itself.
  const boot = readFileSync(new URL("../../src/boot/service.ts", import.meta.url), "utf8");
  assert.match(boot, /if \(resumed\)[^\n]*gate-skipped[^\n]*\n\s*else handoverBaseline = await announceWarming/);
  assert.match(boot, /if \(!resumed\) await runHandoverGate\(/);
  assert.ok(boot.indexOf("markWriter(cfg.dbDir)") > boot.indexOf("litestream.start(servedAtBoot)"));
  const stop = readFileSync(new URL("../../src/shutdown.ts", import.meta.url), "utf8");
  const at = (text: string): number => stop.indexOf(text);
  const [stopped, released, report] = [at("await this.litestream.stop();"), at("clearWriter(this.cfg.dbDir)"), at("if (released) await this.handOver();")] as const;
  assert.ok(stopped > 0 && stopped < released && released < report, "stop → release → report");
});
