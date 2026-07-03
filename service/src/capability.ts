// Per-request capability tokens (spec §6 double control, caller-binding half).
//
// In v2 one VM serves every org and per-app frontend Lambdas hold a blanket
// `execute-api:Invoke`. SigV4 alone proves "some legitimate connector called us"
// — it does NOT bind the caller to an (org, app). The connector therefore mints
// a short-lived HMAC capability token per request; the VM re-derives the HMAC
// with a shared secret and checks the token's (org, app) equals the pair the
// request operates on. No external deps — node:crypto only.
//
// Token format (PINNED — the connector mints byte-identically):
//   v1.<payloadB64>.<sigB64>
//     payloadB64 = base64url(JSON.stringify({ o: orgId, a: appId, e: expEpochSeconds }))  (no padding)
//     sigB64     = base64url(HMAC-SHA256(secret, "v1." + payloadB64))                       (no padding)
import { createHmac, timingSafeEqual } from "node:crypto";

export type CapabilityResult =
  | { ok: true; orgId: string; appId: string }
  | { ok: false; reason: string };

/** base64url (no padding) HMAC-SHA256 of `signingInput` under a UTF-8 `secret`. */
function sign(secret: string, signingInput: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

/**
 * Validate a capability token. NEVER throws — every bad-input path returns the
 * `{ok:false, reason}` arm so the caller can fail closed uniformly. `nowSec` is
 * the current time in epoch seconds (the service passes Math.floor(Date.now()/1000)).
 */
export function verifyCapability(token: string, secret: string, nowSec: number): CapabilityResult {
  try {
    if (typeof token !== "string") return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [version, payloadB64, sigB64] = parts;
    if (version !== "v1" || !payloadB64 || !sigB64) return { ok: false, reason: "malformed" };

    // Authenticate BEFORE trusting the payload: recompute the HMAC over the
    // signing input and timing-safe compare (length-guarded — timingSafeEqual
    // throws on unequal-length buffers).
    const expected = Buffer.from(sign(secret, `v1.${payloadB64}`), "ascii");
    const provided = Buffer.from(sigB64, "ascii");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return { ok: false, reason: "bad_signature" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof payload !== "object" || payload === null) return { ok: false, reason: "malformed" };
    const { o, a, e } = payload as Record<string, unknown>;
    if (typeof o !== "string" || typeof a !== "string" || typeof e !== "number") {
      return { ok: false, reason: "malformed" };
    }
    if (e < nowSec) return { ok: false, reason: "expired" };
    return { ok: true, orgId: o, appId: a };
  } catch {
    // Defense in depth: any unforeseen throw still fails closed.
    return { ok: false, reason: "malformed" };
  }
}
