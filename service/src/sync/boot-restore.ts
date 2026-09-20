// Spec §4 steps 2-3: restore every active app BEFORE the API binds.
import { appKeyOf } from "../apps.ts";
import type { LitestreamApp } from "../litestream.ts";
import { log } from "./log.ts";
import type { SyncState } from "./state.ts";

/**
 * Invariant 2 is untouched: this still returns only once EVERY active app has
 * been restored, and boot.ts binds the port only after it returns. What
 * changed on 2026-08-24 is the order inside that window — the apps used to be
 * restored one after another, and the whole window is a total outage (no org
 * can read or write until it ends).
 *
 * Why concurrency is the right lever here, rather than restoring lazily on
 * first access: the window was measured on prod, and it is latency-bound.
 * 61 apps took 72s, but 54 of the 61 inter-restore gaps were exactly 1s and
 * only one was 14s — one org holds 1320 MB of the fleet's 1352 MB, so ~58 of
 * those seconds were fixed per-app overhead (subprocess spawn + S3
 * round-trips) spent on near-empty databases. Fixed overhead paid serially is
 * exactly what a bounded worker pool removes, and it removes it WITHOUT
 * weakening the restore-then-serve guarantee that lazy restore would trade
 * away.
 *
 * The bound matters as much as the concurrency: each restore is a litestream
 * subprocess, so an unbounded fan-out would spawn one per app on a t4g.micro
 * with 916 MB of RAM. Hence `cfg.bootRestoreConcurrency` workers draining a
 * shared cursor rather than `Promise.all` over every app.
 *
 * Failure semantics are preserved deliberately: boot.ts documents that any
 * failure here aborts the boot, because serving an app whose replica did not
 * come back would silently present an empty database as if it were the
 * customer's data. The first error is therefore rethrown — but only after
 * every in-flight worker has settled, so a failing boot cannot leave orphan
 * restore subprocesses behind it.
 */
export async function bootRestoreAll(state: SyncState): Promise<LitestreamApp[]> {
  const active = await state.registry.listActive();
  const width = Math.max(1, Math.min(state.concurrency, active.length));
  const startedAt = Date.now();

  let cursor = 0;
  let firstError: unknown = null;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Stop handing out work as soon as any worker has failed: the boot is
      // already doomed, and every extra restore is a subprocess we would then
      // have to wait on.
      if (firstError !== null) return;
      const index = cursor++;
      if (index >= active.length) return;
      const ref = active[index]!;
      const app: LitestreamApp = {
        orgId: ref.orgId,
        appId: ref.appId,
        dbPath: state.manager.dbPath(ref.orgId, ref.appId),
      };
      let outcome;
      try {
        outcome = await state.litestream.restoreIfMissing(app);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
      const key = appKeyOf(ref.orgId, ref.appId);
      state.served.set(key, app);
      if (outcome === "existing") state.existingAtBoot.add(key);
      // "fresh" = no replica existed = never written. Leave it out of the
      // config; a request promotes it. Anything else HAS data and must be
      // replicated from the start.
      if (outcome !== "fresh") state.replicated.add(key);
    }
  };

  // allSettled, not all: every worker must finish before we rethrow, so a
  // failed boot never races its own leftover subprocesses.
  await Promise.allSettled(Array.from({ length: width }, () => worker()));
  if (firstError !== null) throw firstError;

  log({
    event: "boot-restore-complete",
    apps: state.served.size,
    replicated: state.replicated.size,
    unusedSkipped: state.served.size - state.replicated.size,
    concurrency: width,
    ms: Date.now() - startedAt,
  });
  return state.replicatedApps;
}
