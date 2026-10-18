import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKEND_MIN_REMAINING_S, callerOf } from "../../src/caller.ts";

const NOW = 1_800_000_000;
const tok = (payload: unknown) => `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

test("remaining life decides: a static backend token vs the connector's per-call one", () => {
  assert.equal(callerOf(tok({ o: "o", a: "a", e: NOW + 10 * 365 * 86400 }), NOW), "backend");
  assert.equal(callerOf(tok({ o: "o", a: "a", e: NOW + 300 }), NOW), "connector");
  assert.equal(callerOf(tok({ o: "o", a: "a", e: NOW + BACKEND_MIN_REMAINING_S }), NOW), "connector");
});

test("no header or an unreadable one reveals nothing", () => {
  assert.equal(callerOf(undefined, NOW), undefined);
  assert.equal(callerOf("garbage", NOW), undefined);
  assert.equal(callerOf("v1.!!!.sig", NOW), undefined);
  assert.equal(callerOf(tok({ o: "o", a: "a" }), NOW), undefined);
});
