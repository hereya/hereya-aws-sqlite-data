import { statSync } from "node:fs";
import { appKeyOf } from "../apps.ts";
import { ServiceError } from "../errors.ts";
import { bindParams, type StatementResult } from "../marshalling.ts";
import {
  assertSafeSql,
  isMultiStatement,
  validateBatchExecute,
  validateQuery,
  validateTx,
} from "../validate.ts";
import type { Authorize, ServerDeps } from "./deps.ts";

export interface Handlers {
  handleQuery: (body: unknown) => Promise<StatementResult>;
  handleBatchExecute: (body: unknown) => Promise<{ updateResults: Array<{ numberOfRecordsUpdated: number }> }>;
  handleTxBegin: (body: unknown) => Promise<{ transactionId: string }>;
  handleTxEnd: (body: unknown, action: "commit" | "rollback") => Promise<{ status: string }>;
  handleStats: (url: URL) => Promise<{ dbSizeBytes: number }>;
}

export function createHandlers(deps: ServerDeps, authorize: Authorize): Handlers {
  const { cfg, manager, txRegistry, limiter } = deps;

  async function handleQuery(body: unknown): Promise<StatementResult> {
    const q = validateQuery(body, cfg.maxSqlBytes);
    assertSafeSql(q.sql);
    await authorize(q.orgId, q.appId);
    // AFTER authorize: an unknown pair is a 403, not a quota answer that would
    // leak whether the org exists.
    await deps.quota?.assertWriteAllowed(q.orgId, q.sql);
    const appKey = appKeyOf(q.orgId, q.appId);
    limiter.acquire(appKey);
    try {
      const useTx = q.transactionId !== undefined;
      if (useTx) txRegistry.use(q.transactionId!, appKey);
      const mode = isMultiStatement(q.sql) ? "script" : "single";
      if (mode === "script" && q.params.length > 0) {
        throw new ServiceError("BAD_REQUEST", "parameters are not supported with multi-statement sql");
      }
      const worker = manager.workerFor(q.orgId, q.appId);
      const result = await worker.exec(
        {
          sql: q.sql,
          binds: bindParams(q.params),
          useTx,
          mode,
          includeMetadata: q.includeResultMetadata,
          maxResponseBytes: cfg.maxResponseBytes,
        },
        cfg.sqlTimeoutMs,
      );
      if (useTx) txRegistry.use(q.transactionId!, appKey); // refresh idle deadline after a long statement
      // "changed the database" is the same definition litestream reacts to —
      // a statement touching zero rows produces no LTX and costs no replication.
      deps.recordWrite?.(q.orgId, q.appId, result.numberOfRecordsUpdated);
      return result;
    } finally {
      limiter.release(appKey);
    }
  }

  async function handleBatchExecute(body: unknown): Promise<{ updateResults: Array<{ numberOfRecordsUpdated: number }> }> {
    const q = validateBatchExecute(body, cfg.maxSqlBytes);
    assertSafeSql(q.sql);
    if (isMultiStatement(q.sql)) {
      throw new ServiceError("BAD_REQUEST", "batch-execute requires a single statement");
    }
    await authorize(q.orgId, q.appId);
    await deps.quota?.assertWriteAllowed(q.orgId, q.sql);
    const appKey = appKeyOf(q.orgId, q.appId);
    limiter.acquire(appKey);
    try {
      const useTx = q.transactionId !== undefined;
      const worker = manager.workerFor(q.orgId, q.appId);
      const updateResults: Array<{ numberOfRecordsUpdated: number }> = [];
      for (const params of q.parameterSets) {
        if (useTx) txRegistry.use(q.transactionId!, appKey);
        const result = await worker.exec(
          {
            sql: q.sql,
            binds: bindParams(params),
            useTx,
            mode: "single",
            includeMetadata: false,
            maxResponseBytes: cfg.maxResponseBytes,
          },
          cfg.sqlTimeoutMs,
        );
        updateResults.push({ numberOfRecordsUpdated: result.numberOfRecordsUpdated });
        deps.recordWrite?.(q.orgId, q.appId, result.numberOfRecordsUpdated);
      }
      return { updateResults };
    } finally {
      limiter.release(appKey);
    }
  }

  async function handleTxBegin(body: unknown): Promise<{ transactionId: string }> {
    const q = validateTx(body, false);
    await authorize(q.orgId, q.appId);
    const appKey = appKeyOf(q.orgId, q.appId);
    if (txRegistry.hasOpenTx(appKey)) {
      throw new ServiceError("BAD_REQUEST", "this app already has an open transaction (one at a time)");
    }
    limiter.acquire(appKey);
    try {
      const worker = manager.workerFor(q.orgId, q.appId);
      await worker.control("begin", cfg.txOpTimeoutMs);
      const entry = txRegistry.create(appKey);
      return { transactionId: entry.txId };
    } finally {
      limiter.release(appKey);
    }
  }

  async function handleTxEnd(body: unknown, action: "commit" | "rollback"): Promise<{ status: string }> {
    const q = validateTx(body, true);
    await authorize(q.orgId, q.appId);
    const appKey = appKeyOf(q.orgId, q.appId);
    if (action === "rollback") {
      // Rollback is idempotent: an expired/unknown tx was already rolled back.
      try {
        txRegistry.use(q.transactionId!, appKey);
      } catch {
        return { status: "rolledback" };
      }
    } else {
      txRegistry.use(q.transactionId!, appKey);
    }
    limiter.acquire(appKey);
    try {
      const worker = manager.workerFor(q.orgId, q.appId);
      await worker.control(action, cfg.txOpTimeoutMs);
      txRegistry.delete(q.transactionId!);
      return { status: action === "commit" ? "committed" : "rolledback" };
    } finally {
      limiter.release(appKey);
    }
  }

  /** Db + WAL file sizes for the usage tool. Requires an active pair. */
  async function handleStats(url: URL): Promise<{ dbSizeBytes: number }> {
    const q = validateTx(
      { org_id: url.searchParams.get("org_id"), app_id: url.searchParams.get("app_id") },
      false,
    );
    await authorize(q.orgId, q.appId);
    const dbPath = manager.dbPath(q.orgId, q.appId);
    let total = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        total += statSync(dbPath + suffix).size;
      } catch {
        // file absent (e.g. never written, or WAL folded) — counts as 0
      }
    }
    return { dbSizeBytes: total };
  }

  return { handleQuery, handleBatchExecute, handleTxBegin, handleTxEnd, handleStats };
}
