// A failing statement's refusal line names the SQLite error and WHO sent it
// (t_refusal_burst_analyser): the connector turns a burst from an app's backend
// into a fiche for that org, and must stay silent about a chat session's own
// typos — the model already sees each of those in its answer.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { audit, setRefusalSink, type AuditLine } from "../../src/server/http.ts";
import { call, startTestService, type TestService } from "../helpers.ts";

const SECRET = "cap-secret-under-test";
const HEADER = "x-dilaya-capability";
const A1 = { org_id: "org-a", app_id: "app-1" };

function mint(expSec: number): string {
  const payload = Buffer.from(JSON.stringify({ o: A1.org_id, a: A1.app_id, e: expSec })).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(`v1.${payload}`).digest("base64url");
  return `v1.${payload}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

let svc: TestService;
const seen: AuditLine[] = [];

before(async () => {
  svc = await startTestService({ capabilitySecret: SECRET, capabilityEnforce: true });
  setRefusalSink((l) => seen.push(l));
});

after(async () => {
  setRefusalSink(null);
  await svc.close();
});

async function failing(token: string): Promise<AuditLine> {
  seen.length = 0;
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT * FROM nope" }, { [HEADER]: token });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "SQL_ERROR");
  assert.equal(seen.length, 1);
  return seen[0]!;
}

test("an app backend's static token (ten years) → via backend, with SQLite's message", async () => {
  const line = await failing(mint(nowSec() + 10 * 365 * 86400));
  assert.equal(line.via, "backend");
  assert.match(line.detail ?? "", /no such table: nope/);
});

test("the connector's per-call token (300 s) → via connector", async () => {
  const line = await failing(mint(nowSec() + 300));
  assert.equal(line.via, "connector");
});

test("an authorization refusal carries neither detail nor via", async () => {
  seen.length = 0;
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" });
  assert.equal(res.status, 403);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.detail, undefined);
  assert.equal(seen[0]!.via, undefined);
});

test("audit() itself is untouched for allowed lines", () => {
  seen.length = 0;
  audit({ ts: new Date().toISOString(), route: "POST /query", allowed: true, ms: 1 });
  assert.equal(seen.length, 0);
});
