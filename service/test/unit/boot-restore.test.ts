// Boot-restore fan-out. The window this covers is a TOTAL OUTAGE: boot.ts binds
// the port only after bootRestoreAll resolves, so every second spent here is a
// second in which no org can read or write. It was serial until 2026-08-24 —
// measured on prod that morning at 61 apps / 72s, of which ~58s were fixed
// per-app overhead on near-empty databases (54 of the 61 gaps were exactly 1s;
// one was 14s because a single org holds 1320 MB of the fleet's 1352 MB).
//
// So these tests assert the three things that make the change safe rather than
// merely fast: every app is still restored before we return (invariant 2), the
// fan-out is BOUNDED (each restore is a litestream subprocess, on a 916 MB
// t4g.micro), and a failure still aborts the boot with no worker left running.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppSync } from "../../src/sync.ts";
import type { Litestream, LitestreamApp } from "../../src/litestream.ts";
import type { Registry } from "../../src/registry.ts";
import type { AppManager } from "../../src/apps.ts";

interface Recorder {
  litestream: Litestream;
  peak: () => number;
  order: () => string[];
}

/** A Litestream stand-in that records concurrency and can fail chosen apps. */
function recordingLitestream(opts: {
  delayMs?: number;
  failOn?: (appId: string) => boolean;
  onRestore?: (app: LitestreamApp) => void;
} = {}): Recorder {
  let inflight = 0;
  let peak = 0;
  const order: string[] = [];
  const litestream = {
    async restoreIfMissing(app: LitestreamApp) {
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
        opts.onRestore?.(app);
        if (opts.failOn?.(app.appId)) throw new Error(`restore failed: ${app.appId}`);
        order.push(app.appId);
        return "restored" as const;
      } finally {
        inflight -= 1;
      }
    },
  } as unknown as Litestream;
  return { litestream, peak: () => peak, order: () => order };
}

function fakeRegistry(count: number): Registry {
  const rows = Array.from({ length: count }, (_, i) => ({ orgId: "org", appId: `app-${i}` }));
  return { listActive: async () => rows } as unknown as Registry;
}

const fakeManager = { dbPath: (o: string, a: string) => `/dbs/${o}/${a}/app.db` } as unknown as AppManager;

test("restores every active app before returning (invariant 2 holds)", async () => {
  const rec = recordingLitestream();
  const sync = new AppSync(fakeRegistry(25), fakeManager, rec.litestream, 8);

  const served = await sync.bootRestoreAll();

  assert.equal(served.length, 25, "every active app must be served when boot-restore returns");
  for (let i = 0; i < 25; i += 1) {
    assert.ok(sync.isServed("org", `app-${i}`), `app-${i} must be served`);
  }
});

test("fan-out is bounded by the configured width", async () => {
  const rec = recordingLitestream({ delayMs: 10 });
  await new AppSync(fakeRegistry(40), fakeManager, rec.litestream, 4).bootRestoreAll();

  // Each restore is a subprocess: unbounded fan-out would spawn one per app.
  assert.ok(rec.peak() <= 4, `peak concurrency ${rec.peak()} exceeded the bound of 4`);
  assert.ok(rec.peak() > 1, "the pool must actually run restores concurrently");
});

test("width never exceeds the number of apps", async () => {
  const rec = recordingLitestream({ delayMs: 5 });
  await new AppSync(fakeRegistry(2), fakeManager, rec.litestream, 16).bootRestoreAll();

  assert.ok(rec.peak() <= 2, `peak concurrency ${rec.peak()} exceeded the app count`);
});

test("an empty registry restores nothing and still completes", async () => {
  const rec = recordingLitestream();
  const served = await new AppSync(fakeRegistry(0), fakeManager, rec.litestream, 8).bootRestoreAll();

  assert.deepEqual(served, []);
  assert.equal(rec.peak(), 0);
});

test("concurrency is what makes the window shorter, not merely allowed", async () => {
  // The measured prod window is latency-bound, so the pool must overlap WAITS.
  // 16 apps x 20ms is 320ms serially; at 8-wide it must land far under that.
  const rec = recordingLitestream({ delayMs: 20 });
  const startedAt = Date.now();
  await new AppSync(fakeRegistry(16), fakeManager, rec.litestream, 8).bootRestoreAll();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 200, `expected the 8-wide pool to beat the 320ms serial floor, took ${elapsed}ms`);
});

test("a failing restore still aborts the boot", async () => {
  // boot.ts documents that any failure here aborts: serving an app whose replica
  // did not come back would present an EMPTY database as the customer's data.
  const rec = recordingLitestream({ failOn: (id) => id === "app-7" });
  const sync = new AppSync(fakeRegistry(20), fakeManager, rec.litestream, 4);

  await assert.rejects(() => sync.bootRestoreAll(), /restore failed: app-7/);
  assert.ok(!sync.isServed("org", "app-7"), "a failed app must never be marked served");
});

test("no restore is still running when the failure is rethrown", async () => {
  // The point of awaiting every worker before rethrowing: a doomed boot must not
  // race its own leftover litestream subprocesses.
  let running = 0;
  let sawRunningAfterThrow = false;
  const rec = recordingLitestream({
    delayMs: 10,
    failOn: (id) => id === "app-2",
    onRestore: () => {},
  });
  const counting = {
    async restoreIfMissing(app: LitestreamApp) {
      running += 1;
      try {
        return await rec.litestream.restoreIfMissing(app);
      } finally {
        running -= 1;
      }
    },
  } as unknown as Litestream;

  const sync = new AppSync(fakeRegistry(30), fakeManager, counting, 6);
  await assert.rejects(() => sync.bootRestoreAll());
  sawRunningAfterThrow = running > 0;

  assert.equal(sawRunningAfterThrow, false, `${running} restores were still in flight after the throw`);
});
