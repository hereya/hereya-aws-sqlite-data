// The relaying side of relay.ts: what a cell does with a request for an app
// another cell holds (t_dbmove_p3_relay_cells).
import type { IncomingMessage } from "node:http";
import { ServiceError } from "../errors.ts";
import { RELAY_HEADER, type RelayedResponse, type RelayRequest } from "../relay.ts";
import type { ServerDeps } from "./deps.ts";

export interface RelayContext {
  orgId: string;
  appId: string;
  capHeader: string | undefined;
  body: unknown;
}

export type RelayOut = (req: IncomingMessage, ctx: RelayContext) => Promise<(RelayedResponse & { toCell: string }) | null>;

export function isRelayed(req: IncomingMessage): boolean {
  return req.headers[RELAY_HEADER] !== undefined;
}

/**
 * Returns null when this request must NOT be relayed — no relay configured, or
 * it already came from a peer (rule 1 of relay.ts) — and the 421 goes out as is.
 */
export function createRelayOut(deps: ServerDeps): RelayOut {
  const { cfg, registry, relay } = deps;
  return async (req, ctx) => {
    if (!relay || !registry.holderOf || isRelayed(req)) return null;
    const out: RelayRequest = {
      method: req.method ?? "POST",
      path: req.url ?? "/",
      capHeader: ctx.capHeader,
      body: req.method === "GET" ? undefined : JSON.stringify(ctx.body),
    };
    const toCell = await registry.holderOf(ctx.orgId, ctx.appId);
    const first = await relay.forward(toCell, out);
    if (first.status !== 421) return { ...first, toCell };

    // The peer says "not mine" — and it re-read placement before saying so
    // (build.ts), so OUR cache is the stale one. Re-read, and try once more.
    // Nothing ran anywhere: a 421 is answered before any statement.
    registry.reloadPlacement?.();
    const again = await registry.holderOf(ctx.orgId, ctx.appId);
    if (again === cfg.cellId || again === toCell) {
      throw new ServiceError("UNAVAILABLE", "placement changed while the request was in flight; retry shortly");
    }
    const second = await relay.forward(again, out);
    if (second.status === 421) {
      throw new ServiceError("UNAVAILABLE", "cells disagree on placement; retry shortly");
    }
    return { ...second, toCell: again };
  };
}
