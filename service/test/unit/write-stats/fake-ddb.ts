// Per-app write recency. Two things are being guarded here, and only one of
// them is "does it count correctly":
//
//  1. It sits on the write path. It must never be able to fail a customer's
//     write — no I/O, no throw, no await on the hot path.
//  2. It must survive an instance replacement. Losing history on every deploy
//     is exactly what made the replica-bucket timestamps useless (four VM rolls
//     on 2026-08-24 erased the signal four times).
import { OBSERVING_SINCE_KEY } from "../../../src/write-stats.ts";

/**
 * DynamoDB stand-in that records commands and can be made to fail.
 *
 * It models `if_not_exists` for the observation date, because that is the whole
 * mechanism under test: the FIRST writer wins and every later one reads the
 * stored value back. A fake that echoed the caller's own timestamp would let a
 * broken implementation restart the clock on every boot and still pass.
 */
export function fakeDdb(opts: { items?: Record<string, unknown>[]; failUpdates?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  let storedSince: string | null = null;
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      if (name === "QueryCommand") return { Items: opts.items ?? [] };
      if (opts.failUpdates) throw new Error("ddb down");
      updates.push(cmd.input);
      const key = cmd.input.Key as Record<string, { S: string }> | undefined;
      if (key?.sk?.S === OBSERVING_SINCE_KEY) {
        const proposed = (cmd.input.ExpressionAttributeValues as Record<string, { N: string }>)[":t"]!.N;
        storedSince ??= proposed;
        return { Attributes: { startedMs: { N: storedSince } } };
      }
      return {};
    },
  };
  return { client, updates, since: () => storedSince };
}

export const OPTS = { tableName: "reg", region: "eu-west-1" };
