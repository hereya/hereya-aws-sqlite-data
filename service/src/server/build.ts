import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ServiceError, toServiceError } from "../errors.ts";
import { validateTx } from "../validate.ts";
import type { ServerDeps } from "./deps.ts";
import { createGate } from "./gate.ts";
import { createHandlers } from "./handlers.ts";
import { audit, CAPABILITY_GATED_POST, CAPABILITY_HEADER, readBody, send, sendRaw } from "./http.ts";
import { parseDrainCell, parseDrainStatus } from "./drain-routes.ts";
import { parseMoveApp, parseMoveIn } from "./move-routes.ts";
import { createRelayOut, isRelayed, ServeHere } from "./relay-out.ts";

export function buildServer(deps: ServerDeps): Server {
  const { cfg, registry, manager, txRegistry } = deps;
  const startedAt = Date.now();
  const { enforceCapability, authorize, assertHeldHere } = createGate(deps);
  const relayOut = createRelayOut(deps);
  const { handleQuery, handleBatchExecute, handleTxBegin, handleTxEnd, handleStats } = createHandlers(
    deps,
    authorize,
  );

  return createServer((req, res) => {
    void handle(req, res);
  });

  /**
   * A peer relayed this because ITS placement says we hold the app. If ours
   * disagrees, one of the two is stale — re-read before answering 421, so that
   * a 421 sent to a peer always means "as of now".
   */
  async function freshenIfRelayed(req: IncomingMessage, orgId?: string, appId?: string): Promise<void> {
    if (!isRelayed(req) || !registry.heldHere || typeof orgId !== "string" || typeof appId !== "string") return;
    if (!(await registry.heldHere(orgId, appId))) registry.reloadPlacement?.();
  }

  async function handle(req: IncomingMessage, res: ServerResponse, again?: { body: unknown }): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const rawCap = req.headers[CAPABILITY_HEADER];
    const capHeader = Array.isArray(rawCap) ? rawCap[0] : rawCap;
    let orgId: string | undefined;
    let appId: string | undefined;
    let body: unknown;
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
      // What an emptied cell waits to see stop before its instance is replaced (drain/drainer.ts).
      if (!isRelayed(req)) deps.onGatewayRequest?.();
      if (deps.isDraining?.()) {
        throw new ServiceError("UNAVAILABLE", "instance is shutting down; retry shortly");
      }
      if (route === "GET /stats") {
        orgId = url.searchParams.get("org_id") ?? undefined;
        appId = url.searchParams.get("app_id") ?? undefined;
        enforceCapability(capHeader, route, orgId, appId);
        await freshenIfRelayed(req, orgId, appId);
        const stats = await handleStats(url);
        audit({ ts: new Date().toISOString(), route, orgId, appId, allowed: true, ms: Date.now() - started });
        send(res, 200, stats);
        return;
      }
      if (req.method !== "POST") {
        throw new ServiceError("BAD_REQUEST", `unknown route: ${route}`);
      }
      body = again ? again.body : await readBody(req, cfg.maxRequestBytes);
      if (typeof body === "object" && body !== null) {
        orgId = (body as Record<string, unknown>).org_id as string | undefined;
        appId = (body as Record<string, unknown>).app_id as string | undefined;
      }
      // Capability gate BEFORE the handler runs, on the exact (org, app) the
      // handler will act on. /admin/sync carries no pair and is not gated.
      if (CAPABILITY_GATED_POST.has(url.pathname)) {
        enforceCapability(capHeader, route, orgId, appId);
      }
      await freshenIfRelayed(req, orgId, appId);
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
          // No pair, so no holder: EVERY cell must drop its caches, or the
          // one that was not asked keeps believing a placement that changed.
          if (deps.relay && !isRelayed(req)) {
            const cells = await deps.relay.broadcast({ method: "POST", path: "/admin/sync", body: "{}" });
            payload = { ...(payload as object), cells };
          }
          break;
        case "/admin/delete-app": {
          // Deliberately NO active-status check: the connector flips the
          // registry row to 'deleting' BEFORE calling this. IAM already
          // guarantees the caller is the legitimate connector.
          const q = validateTx(body, false);
          if (!deps.onDeleteApp) throw new ServiceError("BAD_REQUEST", "delete-app is not available");
          // No authorize() on this route, so placement is checked here: the
          // file to remove is on the holder, and "deleted" from a cell that
          // never had it would leave the real one behind.
          await assertHeldHere(q.orgId, q.appId);
          await deps.onDeleteApp(q.orgId, q.appId);
          orgId = q.orgId;
          appId = q.appId;
          payload = { status: "deleted", note: "local file removed; S3 replica retained" };
          break;
        }
        case "/admin/move-app": {
          if (!deps.moves) throw new ServiceError("BAD_REQUEST", "database moves are not available");
          const q = parseMoveApp(body);
          // Only the holder can move it out: anywhere else this is a MISPLACED,
          // which the catch below relays to the holder like any other request.
          await assertHeldHere(q.orgId, q.appId);
          payload = await deps.moves.out.moveOut(q);
          break;
        }
        case "/admin/move-in": {
          // Cell to cell only: it is not a gateway route, and a caller that is
          // not a peer has no business claiming a database for this cell.
          if (!deps.moves || !isRelayed(req)) throw new ServiceError("BAD_REQUEST", `unknown route: ${route}`);
          payload = await deps.moves.in.moveIn(parseMoveIn(body));
          break;
        }
        case "/admin/drain-cell": {
          if (!deps.drains) throw new ServiceError("BAD_REQUEST", "cell drains are not available");
          const q = parseDrainCell(body);
          payload = q.action === "start" ? await deps.drains.admin.start(q) : await deps.drains.admin.stop(q.cellId);
          // The order is a row; the cell it names must look at it now, not in 30 s.
          deps.drains.poke();
          if (deps.relay) await deps.relay.broadcast({ method: "POST", path: "/admin/sync", body: "{}" });
          break;
        }
        case "/admin/drain-status":
          if (!deps.drains) throw new ServiceError("BAD_REQUEST", "cell drains are not available");
          payload = await deps.drains.admin.status(parseDrainStatus(body).cellId);
          break;
        default:
          throw new ServiceError("BAD_REQUEST", `unknown route: ${route}`);
      }
      audit({ ts: new Date().toISOString(), route, orgId, appId, allowed: true, ms: Date.now() - started });
      send(res, 200, payload);
    } catch (err) {
      let svcErr = toServiceError(err);
      if (svcErr.code === "MISPLACED" && orgId !== undefined && appId !== undefined) {
        // Held by another cell: hand the request over, and the answer back.
        try {
          const relayed = await relayOut(req, { orgId, appId, capHeader, body });
          if (relayed !== null) {
            audit({ ts: new Date().toISOString(), route, orgId, appId, allowed: relayed.status < 400, code: `RELAYED_${relayed.toCell}`, ms: Date.now() - started });
            sendRaw(res, relayed.status, relayed.body);
            return;
          }
        } catch (relayErr) {
          // Once: a second ServeHere would mean placement flapping, and is a 500.
          if (relayErr instanceof ServeHere && !again) return handle(req, res, { body });
          err = relayErr;
          svcErr = toServiceError(relayErr);
        }
      }
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
