// An EMPTIED cell and Cloud Map (t_dbmove_p5_drain_ops): it leaves without
// forgetting who it is, its replacement instance does not walk back in, and
// lifting the order brings it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudMapRegistration } from "../../src/cloudmap.ts";

function registration(existing: { Id: string; Attributes?: Record<string, string> }[] = []) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return cmd.constructor.name === "ListInstancesCommand" ? { Instances: existing } : {};
    },
  };
  const reg = new CloudMapRegistration({ serviceId: "srv", region: "eu-west-1", port: 8080, cellId: "1", client: client as never, identity: async () => ["i-new", "10.0.0.9"] });
  const names = () => sent.map((s) => s.name).filter((n) => n !== "ListInstancesCommand");
  return { reg, names };
}

test("an ordinary boot registers", async () => {
  const { reg, names } = registration();
  await reg.register();
  assert.deepEqual(names(), ["RegisterInstanceCommand"]);
  assert.equal(reg.inCloudMap, true);
});

test("the replacement of a drained cell clears its predecessor and STAYS OUT — but knows who it is", async () => {
  const { reg, names } = registration([{ Id: "i-old", Attributes: { DILAYA_CELL: "1" } }]);
  await reg.register({ enter: false });
  assert.deepEqual(names(), ["DeregisterInstanceCommand"]);
  assert.equal(reg.inCloudMap, false);
  assert.equal(reg.registered?.instanceId, "i-new", "the `_vms` row is what keeps it reachable through the relay");
});

test("leave keeps the identity, so that enter can bring the same instance back", async () => {
  const { reg, names } = registration();
  await reg.register();
  await reg.leave();
  assert.equal(reg.inCloudMap, false);
  await reg.enter();
  assert.equal(reg.inCloudMap, true);
  assert.deepEqual(names(), ["RegisterInstanceCommand", "DeregisterInstanceCommand", "RegisterInstanceCommand"]);
});

test("a leave that Cloud Map refused is not believed", async () => {
  const { reg } = registration();
  await reg.register();
  (reg as unknown as { client: { send: () => Promise<never> } }).client = { send: async () => Promise.reject(new Error("throttled")) };
  await assert.rejects(reg.leave(), /throttled/);
  assert.equal(reg.inCloudMap, true);
});
