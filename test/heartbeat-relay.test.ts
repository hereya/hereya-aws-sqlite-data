// The relay reads the bot token from SSM. Two shapes reach it, and picking the
// wrong one is silent until an alarm actually fires — which is the one moment
// nobody is watching. So the extraction is pinned here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { tokenFrom } = require_("../lib/heartbeat-relay/token.js");

test("reads bot_token out of the connector's Telegram credentials record", () => {
  // The exact shape attach-telegram writes to
  // /dilaya/<orgId>/apps/<app>/telegram/credentials — verified in prod 2026-08-07.
  const stored = JSON.stringify({ bot_token: "123456:AAE-secret", secret_token: "webhook-secret" });
  assert.equal(tokenFrom(stored), "123456:AAE-secret");
});

test("accepts a bare token, so a dedicated parameter keeps working", () => {
  assert.equal(tokenFrom("123456:AAE-secret"), "123456:AAE-secret");
});

test("never returns the webhook secret", () => {
  const stored = JSON.stringify({ bot_token: "the-token", secret_token: "NOT-THE-TOKEN" });
  assert.equal(tokenFrom(stored), "the-token");
  assert.ok(!tokenFrom(stored).includes("NOT-THE-TOKEN"));
});

test("falls back to the raw value on any unexpected shape", () => {
  // Never throw at alarm time: a wrong-shaped parameter must still attempt a
  // send (and fail loudly on Telegram's side) rather than crash the relay
  // before it can report anything.
  assert.equal(tokenFrom("{not json"), "{not json");
  assert.equal(tokenFrom(JSON.stringify({ secret_token: "only" })), '{"secret_token":"only"}');
  assert.equal(tokenFrom(JSON.stringify({ bot_token: 42 })), '{"bot_token":42}');
  assert.equal(tokenFrom("null"), "null");
});
