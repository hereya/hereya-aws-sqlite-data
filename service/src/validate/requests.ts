import { ServiceError } from "../errors.ts";
import type { SqlParameter } from "../marshalling.ts";

// org_id / app_id are opaque ids (UUIDs today, reserved ids like the per-org db
// may start with an underscore). No dots, no slashes — they become path segments
// on disk and in S3, so the shape itself rules out traversal.
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TX_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const FIELD_KEYS = ["stringValue", "longValue", "doubleValue", "booleanValue", "isNull", "blobValue"] as const;

export interface QueryRequest {
  orgId: string;
  appId: string;
  sql: string;
  params: SqlParameter[];
  transactionId?: string;
  includeResultMetadata: boolean;
}

export interface BatchExecuteRequest {
  orgId: string;
  appId: string;
  sql: string;
  parameterSets: SqlParameter[][];
  transactionId?: string;
}

export interface TxRequest {
  orgId: string;
  appId: string;
  transactionId?: string;
}

function bad(message: string): never {
  throw new ServiceError("BAD_REQUEST", message);
}

function requireRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) bad("request body must be a JSON object");
  return body as Record<string, unknown>;
}

function requireId(obj: Record<string, unknown>, key: "org_id" | "app_id"): string {
  const v = obj[key];
  if (typeof v !== "string" || !ID_RE.test(v)) bad(`${key} is required and must match ${ID_RE}`);
  return v;
}

function requireSql(obj: Record<string, unknown>, maxSqlBytes: number): string {
  const v = obj.sql;
  if (typeof v !== "string" || v.trim().length === 0) bad("sql is required and must be a non-empty string");
  if (Buffer.byteLength(v, "utf8") > maxSqlBytes) bad(`sql exceeds ${maxSqlBytes} bytes`);
  return v;
}

function optionalTxId(obj: Record<string, unknown>): string | undefined {
  const v = obj.transactionId;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !TX_ID_RE.test(v)) bad("transactionId must be a short id string");
  return v;
}

export function validateParams(raw: unknown): SqlParameter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) bad("params must be an array");
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) bad(`params[${i}] must be an object`);
    const p = entry as Record<string, unknown>;
    if (typeof p.name !== "string" || !PARAM_NAME_RE.test(p.name)) {
      bad(`params[${i}].name must match ${PARAM_NAME_RE}`);
    }
    if (typeof p.value !== "object" || p.value === null) bad(`params[${i}].value must be an object`);
    const value = p.value as Record<string, unknown>;
    const present = FIELD_KEYS.filter((k) => value[k] !== undefined);
    if (present.length !== 1) {
      bad(`params[${i}].value must have exactly one of ${FIELD_KEYS.join(", ")}`);
    }
    const key = present[0]!;
    const v = value[key];
    switch (key) {
      case "stringValue":
        if (typeof v !== "string") bad(`params[${i}].value.stringValue must be a string`);
        break;
      case "longValue":
        if (typeof v !== "number" || !Number.isInteger(v)) bad(`params[${i}].value.longValue must be an integer`);
        break;
      case "doubleValue":
        if (typeof v !== "number" || !Number.isFinite(v)) bad(`params[${i}].value.doubleValue must be a finite number`);
        break;
      case "booleanValue":
        if (typeof v !== "boolean") bad(`params[${i}].value.booleanValue must be a boolean`);
        break;
      case "isNull":
        if (v !== true) bad(`params[${i}].value.isNull must be true`);
        break;
      case "blobValue":
        if (typeof v !== "string") bad(`params[${i}].value.blobValue must be a base64 string`);
        break;
    }
    const typeHint = p.typeHint === undefined ? undefined : String(p.typeHint);
    return { name: p.name, value: { [key]: v } as SqlParameter["value"], typeHint };
  });
}

export function validateQuery(body: unknown, maxSqlBytes: number): QueryRequest {
  const obj = requireRecord(body);
  return {
    orgId: requireId(obj, "org_id"),
    appId: requireId(obj, "app_id"),
    sql: requireSql(obj, maxSqlBytes),
    params: validateParams(obj.params),
    transactionId: optionalTxId(obj),
    includeResultMetadata: obj.includeResultMetadata !== false,
  };
}

export function validateBatchExecute(body: unknown, maxSqlBytes: number): BatchExecuteRequest {
  const obj = requireRecord(body);
  const rawSets = obj.parameterSets;
  if (!Array.isArray(rawSets)) bad("parameterSets must be an array of parameter arrays");
  if (rawSets.length > 1000) bad("parameterSets is limited to 1000 entries per call");
  return {
    orgId: requireId(obj, "org_id"),
    appId: requireId(obj, "app_id"),
    sql: requireSql(obj, maxSqlBytes),
    parameterSets: rawSets.map((s) => validateParams(s)),
    transactionId: optionalTxId(obj),
  };
}

export function validateTx(body: unknown, requireTxId: boolean): TxRequest {
  const obj = requireRecord(body);
  const txId = optionalTxId(obj);
  if (requireTxId && !txId) bad("transactionId is required");
  return { orgId: requireId(obj, "org_id"), appId: requireId(obj, "app_id"), transactionId: txId };
}
