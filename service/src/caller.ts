// Who sent a request: an app's own backend, or the connector on behalf of a
// chat session (t_refusal_burst_analyser).
//
// A burst of SQL_ERROR means two very different things. From a chat session,
// the model running the `query` tool sees every error in its own answer and
// corrects itself — nobody needs telling. From an app's BACKEND, the error is
// swallowed by a page that answers 200 regardless: on 2026-10-17 two apps of
// one org sent 162 failing statements in 5 s while their users looked at what
// were most likely empty pages, and nothing anywhere said so. Only the second
// deserves a fiche, so the refusal line has to say which one it is.
//
// The capability token already tells them apart, without a new header: the
// connector mints one per call that lives 300 s (src/capability.ts on its side),
// while an app's Lambda carries the STATIC token minted when the Lambda was
// created, for ten years (app-lambda/app-env.ts there). The token is read, not
// verified, here: this only ever runs on a request the gate already let
// through (a SQL_ERROR is raised past it), and the label it yields only decides
// whether the request's OWN org is told about its OWN app.

/** Above this much remaining life, the token is a backend's static one. */
export const BACKEND_MIN_REMAINING_S = 24 * 3600;

export type Caller = "backend" | "connector";

/** The caller a capability header reveals, or undefined when it reveals none. */
export function callerOf(capHeader: string | undefined, nowSec: number): Caller | undefined {
  if (typeof capHeader !== "string") return undefined;
  const payloadB64 = capHeader.split(".")[1];
  if (!payloadB64) return undefined;
  try {
    const { e } = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { e?: unknown };
    if (typeof e !== "number") return undefined;
    return e - nowSec > BACKEND_MIN_REMAINING_S ? "backend" : "connector";
  } catch {
    return undefined;
  }
}
