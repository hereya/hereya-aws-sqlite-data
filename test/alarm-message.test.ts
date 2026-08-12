// What the relay says, and when it stays quiet. Both halves are load-bearing:
// a wrong first sentence misleads at the one moment somebody reads fast, and an
// unfiltered birth-OK trains everyone to ignore the channel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { shouldAnnounce } = require_("../lib/heartbeat-relay/announce.js");
const { formatMessage } = require_("../lib/heartbeat-relay/format.js");

const STACK = "p-263b1e67-4f7d-498a-8f5a-8635f2e68a87";

test("a brand-new alarm's INSUFFICIENT_DATA → OK is NOT announced", () => {
  // The birth of an alarm, i.e. what every deploy that adds one produces.
  assert.equal(
    shouldAnnounce({ NewStateValue: "OK", OldStateValue: "INSUFFICIENT_DATA" }),
    false,
  );
});

test("a real recovery IS announced", () => {
  assert.equal(shouldAnnounce({ NewStateValue: "OK", OldStateValue: "ALARM" }), true);
});

test("ALARM is always announced, and so is anything unrecognised", () => {
  assert.equal(shouldAnnounce({ NewStateValue: "ALARM", OldStateValue: "OK" }), true);
  assert.equal(shouldAnnounce({ NewStateValue: "INSUFFICIENT_DATA" }), true);
  assert.equal(shouldAnnounce({}), true);
  assert.equal(shouldAnnounce(null), true);
});

test("a registry alarm is not described as a dead heartbeat", () => {
  // The regression this split exists for: before it, ANY alarm on this topic
  // was announced with the heartbeat's sentence.
  const msg = formatMessage({
    AlarmName: `${STACK}-registry-throttles`,
    NewStateValue: "ALARM",
    NewStateReason: "Threshold Crossed: 1 datapoint [3.0]",
  });
  assert.ok(msg.includes("registre DynamoDB"), "must name the registry");
  assert.ok(!msg.includes("heartbeat"), "must not claim the heartbeat is silent");
  assert.ok(msg.includes("Threshold Crossed"), "must keep CloudWatch's own reason");
  assert.ok(msg.startsWith("🔴"));
});

test("the heartbeat keeps its own wording and its recovery hint", () => {
  const msg = formatMessage({
    AlarmName: `${STACK}-heartbeat`,
    NewStateValue: "ALARM",
    NewStateReason: "Insufficient Data",
  });
  assert.ok(msg.includes("heartbeat s'est tu"));
  assert.ok(msg.includes("~2 min"));
});

test("an alarm nobody wrote a sentence for is still announced, with its reason", () => {
  const msg = formatMessage({
    AlarmName: `${STACK}-something-new`,
    NewStateValue: "ALARM",
    NewStateReason: "Threshold Crossed",
  });
  assert.ok(msg.includes("something-new"));
  assert.ok(msg.includes("Threshold Crossed"));
});

test("recovery and unknown states stay short and named", () => {
  const ok = formatMessage({ AlarmName: `${STACK}-no-instance`, NewStateValue: "OK" });
  assert.ok(ok.startsWith("🟢"));
  assert.ok(ok.includes("no-instance"));

  const unknown = formatMessage({ AlarmName: "x", NewStateValue: "UNKNOWN", NewStateReason: "raw" });
  assert.ok(unknown.startsWith("⚪️"));
  assert.ok(unknown.includes("raw"));
});

test("a message with no alarm at all does not crash the relay", () => {
  assert.ok(formatMessage({}).includes("alarme inconnue"));
  assert.ok(formatMessage(null).includes("alarme inconnue"));
});
