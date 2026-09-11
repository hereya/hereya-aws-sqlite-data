import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ServiceError, toServiceError } from "../errors.ts";
import { validateTx } from "../validate.ts";
import type { ServerDeps } from "./deps.ts";
import { createGate } from "./gate.ts";
import { createHandlers } from "./handlers.ts";
import { audit, CAPABILITY_GATED_POST, CAPABILITY_HEADER, readBody, send } from "./http.ts";

export function buildServer(deps: ServerDeps): Server {
  const { cfg, registry, manager, txRegistry } = deps;
  const startedAt = Date.now();
  const { enforceCapability, authorize } = createGate(deps);
  const { handleQuery, handleBatchExecute, handleTxBegin, handleTxEnd, handleStats } = createHandlers(
    deps,
    authorize,
  );

  return createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const rawCap = req.headers[CAPABILITY_HEADER];
    const capHeader = Array.isArray(rawCap) ? rawCap[0] : rawCap;
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
      if (route === "GET /stats") {
        orgId = url.searchParams.get("org_id") ?? undefined;
        appId = url.searchParams.get("app_id") ?? undefined;
        enforceCapability(capHeader, route, orgId, appId);
        const stats = await handleStats(url);
        audit({ ts: new Date().toISOString(), route, orgId, appId, allowed: true, ms: Date.now() - started });
        send(res, 200, stats);
        return;
      }
      if (req.method !== "POST") {
        throw new ServiceError("BAD_REQUEST", `unknown route: ${route}`);
      }
      const body = await readBody(req, cfg.maxRequestBytes);
      if (typeof body === "object" && body !== null) {
        orgId = (body as Record<string, unknown>).org_id as string | undefined;
        appId = (body as Record<string, unknown>).app_id as string | undefined;
      }
      // Capability gate BEFORE the handler runs, on the exact (org, app) the
      // handler will act on. /admin/sync carries no pair and is not gated.
      if (CAPABILITY_GATED_POST.has(url.pathname)) {
        enforceCapability(capHeader, route, orgId, appId);
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
        case "/admin/delete-app": {
          // Deliberately NO active-status check: the connector flips the
          // registry row to 'deleting' BEFORE calling this. IAM already
          // guarantees the caller is the legitimate connector.
          const q = validateTx(body, false);
          if (!deps.onDeleteApp) throw new ServiceError("BAD_REQUEST", "delete-app is not available");
          await deps.onDeleteApp(q.orgId, q.appId);
          orgId = q.orgId;
          appId = q.appId;
          payload = { status: "deleted", note: "local file removed; S3 replica retained" };
          break;
        }
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
