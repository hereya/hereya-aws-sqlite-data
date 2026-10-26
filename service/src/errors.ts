export type ErrorCode =
  | "BAD_REQUEST"
  | "SQL_FORBIDDEN"
  | "CROSS_ORG_DENIED"
  | "CAPABILITY_DENIED"
  | "THROTTLED"
  | "DB_QUOTA_EXCEEDED"
  | "QUERY_TIMEOUT"
  | "RESULT_TOO_LARGE"
  | "SQL_ERROR"
  | "TX_NOT_FOUND"
  | "TX_EXPIRED"
  | "MISPLACED"
  | "MOVE_ABORTED"
  | "UNAVAILABLE"
  | "ORG_MIGRATING"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  SQL_FORBIDDEN: 400,
  CROSS_ORG_DENIED: 403,
  CAPABILITY_DENIED: 403,
  THROTTLED: 429,
  // Same 429 as THROTTLED, and for the same reason: a limit the caller can
  // come back from. The distinct code says which limit — retrying later helps
  // with one, freeing space is the only way past the other.
  DB_QUOTA_EXCEEDED: 429,
  QUERY_TIMEOUT: 408,
  RESULT_TOO_LARGE: 413,
  SQL_ERROR: 400,
  TX_NOT_FOUND: 409,
  TX_EXPIRED: 409,
  // Active, but held by another cell (placement.ts). 421 Misdirected Request:
  // nothing ran here, and nothing may — this cell must not even restore it.
  MISPLACED: 421,
  // A database move gave up BEFORE anything changed hands (open transaction,
  // statements that would not drain, an unobserved litestream stop). The app
  // is exactly where and how it was.
  MOVE_ABORTED: 409,
  UNAVAILABLE: 503,
  // The org is moving region (fence.ts): writes are held for a few minutes.
  // 503 + Retry-After is what app runtimes and senders read as "come back".
  ORG_MIGRATING: 503,
  INTERNAL: 500,
};

/** Seconds a refused caller is told to wait (Retry-After). Same as the connector's FREEZE_RETRY_AFTER_S. */
const RETRY_AFTER_S: Partial<Record<ErrorCode, number>> = { ORG_MIGRATING: 120 };

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterS: number | undefined;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterS = RETRY_AFTER_S[code];
  }
}

export function toServiceError(err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ServiceError("INTERNAL", message);
}
