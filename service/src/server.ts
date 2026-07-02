import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { ServiceError, toServiceError } from "./errors.ts";
import { bindParams, type StatementResult } from "./marshalling.ts";
import type { AppManager } from "./apps.ts";
import { appKeyOf } from "./apps.ts";
import type { Registry } from "./registry.ts";
import type { TxRegistry } from "./tx.ts";
import type { Limiter } from "./limits.ts";
import {
  assertSafeSql,
  isMultiStatement,
  validateBatchExecute,
  validateQuery,
  validateTx,
} from "./validate.ts";

export interface ServerDeps {
  cfg: Config;
  registry: Registry;
  manager: AppManager;
  txRegistry: TxRegistry;
  limiter: Limiter;
  /** Restore-before-first-query hook (hot-add); absent in bare-core tests. */
  ensureServed?: (orgId: string, appId: string) => Promise<void>;
  onAdminSync?: () => Promise<{ added: number; removed: number }>;
  health?: () => Record<string, unknown>;
  /** While draining (shutdown/spot notice), everything but /health gets 503. */
  isDraining?: () => boolean;
}

interface AuditLine {
  ts: string;
  route: string;
  orgId?: string;
  appId?: string;
  allowed: boolean;
  code?: string;
  ms: number;
}

function audit(line: AuditLine): void {
  console.log(JSON.stringify({ type: "audit", ...line }));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new ServiceError("BAD_REQUEST", `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("BAD_REQUEST", "request body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function buildServer(deps: ServerDeps): Server {
  const { cfg, registry, manager, txRegistry, limiter } = deps;
  const startedAt = Date.now();

  /** Fail-closed org/app check — the VM-side half of the spec §6 double control. */
  async function authorize(orgId: string, appId: string): Promise<void> {
    const status = await registry.lookup(orgId, appId);
    if (status !== "active") {
      throw new ServiceError("CROSS_ORG_DENIED", "unknown or inactive org/app pair");
    }
    // Registry says active: make sure the local db is restored before any
    // worker can create an empty file that would shadow the S3 replica.
    if (deps.ensureServed) await deps.ensureServed(orgId, appId);
  }

  async function handleQuery(body: unknown): Promise<StatementResult> {
    const q = validateQuery(body, cfg.maxSqlBytes);
    assertSafeSql(q.sql);
    await authorize(q.orgId, q.appId);
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

  return createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    let orgId: string | undefined;
    let appId: string | undefined;
    try {
      if (route === "GET /health") {
        send(res, 200, {
          status: "ok",
          apps: manager.openApps,
          openTransactions: txRegistry.size,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          ...(deps.health?.() ?? {}),
        });
        return;
      }
      if (deps.isDraining?.()) {
        throw new ServiceError("UNAVAILABLE", "instance is shutting down; retry shortly");
      }
      if (req.method !== "POST") {
        throw new ServiceError("BAD_REQUEST", `unknown route: ${route}`);
      }
      const body = await readBody(req, cfg.maxRequestBytes);
      if (typeof body === "object" && body !== null) {
        orgId = (body as Record<string, unknown>).org_id as string | undefined;
        appId = (body as Record<string, unknown>).app_id as string | undefined;
      }
      let payload: unknown;
      switch (url.pathname) {
        case "/query":
          payload = await handleQuery(body);
          break;
        case "/batch-execute":
          payload = await handleBatchExecute(body);
          break;
        case "/tx/begin":
          payload = await handleTxBegin(body);
          break;
        case "/tx/commit":
          payload = await handleTxEnd(body, "commit");
          break;
        case "/tx/rollback":
          payload = await handleTxEnd(body, "rollback");
          break;
        case "/admin/sync":
          if (deps.onAdminSync) {
            payload = await deps.onAdminSync();
          } else {
            await registry.reload();
            payload = { status: "reloaded" };
          }
          break;
        default:
          throw new ServiceError("BAD_REQUEST", `unknown route: ${route}`);
      }
      audit({ ts: new Date().toISOString(), route, orgId, appId, allowed: true, ms: Date.now() - started });
      send(res, 200, payload);
    } catch (err) {
      const svcErr = toServiceError(err);
      if (svcErr.code === "INTERNAL") {
        console.error(JSON.stringify({ type: "error", route, message: svcErr.message, stack: (err as Error)?.stack }));
      }
      audit({
        ts: new Date().toISOString(),
        route,
        orgId,
        appId,
        allowed: false,
        code: svcErr.code,
        ms: Date.now() - started,
      });
      send(res, svcErr.status, { error: { code: svcErr.code, message: svcErr.message } });
    }
  }
}
