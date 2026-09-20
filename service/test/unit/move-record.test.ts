// The conditional writes ARE the safety rule of a move (move/record.ts): what
// is pinned here is each condition as DynamoDB receives it. That exactly one of
// `cancel` and `claim` wins is then DynamoDB's guarantee, not ours.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DdbMoveRecord } from "../../src/move/record.ts";

function recorder(reply: () => unknown = () => ({ Attributes: { version: { N: "4" } } })) {
  const inputs: Array<Record<string, any>> = [];
  const client = {
    async send(cmd: { input: Record<string, any> }) {
      inputs.push(cmd.input);
      return reply();
    },
  };
  return { record: new DdbMoveRecord({ tableName: "t", region: "eu-west-1", client: client as never }), inputs };
}

test("begin: only on a row that is the source's (or absent) and carries no move", async () => {
  const { record, inputs } = recorder();
  assert.equal(await record.begin("o", "a", "0", "1"), 4);
  const [input] = inputs;
  assert.deepEqual(input!.Key, { org_id: { S: "_placement" }, sk: { S: "o/a" } });
  assert.equal(input!.ConditionExpression, "(attribute_not_exists(#vm) OR #vm = :from) AND attribute_not_exists(#ph)");
  assert.match(input!.UpdateExpression, /#v = if_not_exists\(#v, :zero\) \+ :one/);
});

test("cancel is refused from `b_started` on; claim only from `a_stopped` and only by the named target", async () => {
  const { record, inputs } = recorder();
  await record.cancel("o", "a", 4);
  await record.claim("o", "a", 4, "1");
  await record.finalize("o", "a", 4, "1");
  assert.equal(inputs[0]!.ConditionExpression, "#v = :v AND #ph IN (:moving, :stopped)");
  assert.deepEqual(inputs[0]!.ExpressionAttributeValues[":stopped"], { S: "a_stopped" });
  assert.equal(inputs[1]!.ConditionExpression, "#v = :v AND #ph = :stopped AND #tv = :me");
  assert.equal(inputs[2]!.ConditionExpression, "#v = :v AND #ph = :started AND #tv = :me");
  assert.match(inputs[2]!.UpdateExpression, /SET #vm = :me, #v = #v \+ :one REMOVE #ph, #tv/);
});

test("only the placeholders an expression USES are declared — DynamoDB rejects an unused one", async () => {
  const { record, inputs } = recorder();
  await record.reportStopped("o", "a", 4);
  await record.cancel("o", "a", 4);
  assert.deepEqual(Object.keys(inputs[0]!.ExpressionAttributeNames).sort(), ["#ph", "#v"]);
  assert.deepEqual(Object.keys(inputs[1]!.ExpressionAttributeNames).sort(), ["#ph", "#tv", "#v"]);
  for (const input of inputs) {
    const text = `${input.UpdateExpression} ${input.ConditionExpression}`;
    for (const value of Object.keys(input.ExpressionAttributeValues)) assert.ok(text.includes(value), `${value} unused`);
  }
});

test("a failed condition is an ANSWER (false/null); any other error is thrown, never read as one", async () => {
  const lost = recorder(() => {
    throw new ConditionalCheckFailedException({ message: "no", $metadata: {} });
  });
  assert.equal(await lost.record.claim("o", "a", 1, "1"), false);
  assert.equal(await lost.record.begin("o", "a", "0", "1"), null);
  const down = recorder(() => {
    throw new Error("throttled");
  });
  await assert.rejects(down.record.cancel("o", "a", 1), /throttled/);
});
