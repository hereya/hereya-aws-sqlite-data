import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceError } from "../errors.ts";

export interface AuditLine {
  ts: string;
  route: string;
  orgId?: string;
  appId?: string;
  allowed: boolean;
  code?: string;
  /** SQL_ERROR only: SQLite's own message, bounded (DETAIL_MAX). */
  detail?: string;
  /** SQL_ERROR only: an app's backend or the connector (caller.ts). */
  via?: "backend" | "connector";
  ms: number;
}

/** "no such table: invoices" is the whole diagnosis; a long one is cut. */
export const DETAIL_MAX = 200;

// Where `allowed:false` lines go besides the journal (refusals.ts). Null until
// the boot wires a log group — and in every in-process test boot.
let refusalSink: ((line: AuditLine) => void) | null = null;

export function setRefusalSink(sink: ((line: AuditLine) => void) | null): void {
  refusalSink = sink;
}

export function audit(line: AuditLine): void {
  console.log(JSON.stringify({ type: "audit", ...line }));
  if (!line.allowed) refusalSink?.(line);
}

// The capability header the connector attaches per request (Node lowercases
// header names). Its (org, app) claim must equal the pair the request touches.
export const CAPABILITY_HEADER = "x-dilaya-capability";

// POST routes that carry an (org_id, app_id) and are therefore capability-gated.
// NOT gated: /admin/sync (no pair) — /admin/delete-app IS gated even though it
// skips the active-status check (IAM + capability still bind the caller).
export const CAPABILITY_GATED_POST = new Set([
  "/query",
  "/batch-execute",
  "/tx/begin",
  "/tx/commit",
  "/tx/rollback",
  "/admin/delete-app",
]);

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
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

export function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** A peer's answer, handed back byte for byte (relay-out.ts). */
export function sendRaw(res: ServerResponse, status: number, payload: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
