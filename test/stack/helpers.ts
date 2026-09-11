// Template-level enforcement of the spec's non-negotiables (§3, §13):
// no S3 lifecycle/versioning, no SSH keypair, IMDSv2 required, 1/1/1 ASG with
// capacity rebalance off, least-privilege role (never s3:*).
import { rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { HereyaAwsSqliteDataStack } from "../../lib/hereya-aws-sqlite-data-stack.ts";

// Synthesising this stack bundles the service artifact, which runs
// scripts/build-service.mjs into the REPO-WIDE dist/. The test runner executes
// these files in parallel processes, so without a cross-process lock two synths
// write that directory at once and one of them fails to bundle. The lock is
// taken on the first synth of a file and released when that file is done, so
// stacks built inside test bodies are covered too.
const LOCK_PATH = join(tmpdir(), "hereya-aws-sqlite-data-synth.lock");
const STALE_MS = 120_000;
const WAIT_MS = 300_000;
let held = false;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireSynthLock(): void {
  if (held) return;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      held = true;
      return;
    } catch {
      // A holder that died leaves the file behind; steal it once it is stale.
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) rmSync(LOCK_PATH, { force: true });
      } catch {
        // released between the failed create and the stat — just retry
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK_PATH}`);
      sleepSync(50);
    }
  }
}

function releaseSynthLock(): void {
  if (!held) return;
  held = false;
  rmSync(LOCK_PATH, { force: true });
}

after(releaseSynthLock);
process.on("exit", releaseSynthLock);

export function buildTemplate(): Template {
  acquireSynthLock();
  const app = new cdk.App();
  const stack = new HereyaAwsSqliteDataStack(app, "TestStack", {
    env: { account: "111111111111", region: "eu-west-1" },
  });
  return Template.fromStack(stack);
}
