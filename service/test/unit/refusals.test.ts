// Refused requests leave the VM (t_dataapi_audit_cw). What has to hold: only
// `allowed:false` lines ship, a relay hop is not counted twice, the buffer is
// bounded and its drops are counted, and no CloudWatch failure ever throws.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BUFFERED, RefusalLog } from "../../src/refusals.ts";
import { audit, setRefusalSink, type AuditLine } from "../../src/server/http.ts";

interface Sent {
  kind: string;
  input: { logGroupName?: string; logStreamName?: string; logEvents?: { timestamp: number; message: string }[] };
}

function recordingClient(fail: (kind: string) => Error | null = () => null) {
  const sent: Sent[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Sent["input"] }) => {
      const kind = cmd.constructor.name;
      sent.push({ kind, input: cmd.input });
      const err = fail(kind);
      if (err) throw err;
      return {};
    },
  };
  return { client, sent, puts: () => sent.filter((s) => s.kind === "PutLogEventsCommand") };
}

function line(over: Partial<AuditLine> = {}): AuditLine {
  return { ts: "2026-10-16T10:00:00.000Z", route: "/query", orgId: "o1", appId: "a1", allowed: false, code: "SQL_ERROR", ms: 3, ...over };
}

function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

test("ships only refusals, with org/app/code and the cell, to one stream", async () => {
  const rec = recordingClient();
  const log = new RefusalLog({ logGroup: "/g", cellId: "1", flushMs: 60_000, client: rec.client, stream: "s" });
  log.record(line({ allowed: true, code: undefined }));
  log.record(line());
  log.record(line({ code: "RELAYED_0" }));
  await log.flush();
  const [put] = rec.puts();
  assert.ok(put);
  assert.equal(put.input.logGroupName, "/g");
  assert.equal(put.input.logStreamName, "s");
  assert.equal(put.input.logEvents?.length, 1);
  const msg = JSON.parse(put.input.logEvents![0]!.message);
  assert.deepEqual([msg.type, msg.orgId, msg.appId, msg.code, msg.cell], ["audit", "o1", "a1", "SQL_ERROR", "1"]);
  assert.equal(put.input.logEvents![0]!.timestamp, Date.parse("2026-10-16T10:00:00.000Z"));
});

test("an empty window sends nothing, and the stream is created once", async () => {
  const rec = recordingClient((k) => (k === "CreateLogStreamCommand" ? named("ResourceAlreadyExistsException") : null));
  const log = new RefusalLog({ logGroup: "/g", cellId: "0", flushMs: 60_000, client: rec.client, stream: "s" });
  await log.flush();
  assert.equal(rec.sent.length, 0);
  log.record(line());
  await log.flush();
  log.record(line());
  await log.flush();
  assert.equal(rec.sent.filter((s) => s.kind === "CreateLogStreamCommand").length, 1);
  assert.equal(rec.puts().length, 2);
});

test("events go out in chronological order (PutLogEvents refuses otherwise)", async () => {
  const rec = recordingClient();
  const log = new RefusalLog({ logGroup: "/g", cellId: "0", flushMs: 60_000, client: rec.client, stream: "s" });
  log.record(line({ ts: "2026-10-16T10:00:02.000Z" }));
  log.record(line({ ts: "2026-10-16T10:00:01.000Z" }));
  await log.flush();
  const ts = rec.puts()[0]!.input.logEvents!.map((e) => e.timestamp);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test("the buffer is bounded and what it drops is COUNTED, not silent", async () => {
  const rec = recordingClient();
  const log = new RefusalLog({ logGroup: "/g", cellId: "0", flushMs: 60_000, client: rec.client, stream: "s" });
  for (let i = 0; i < MAX_BUFFERED + 7; i++) log.record(line());
  await log.flush();
  const events = rec.puts()[0]!.input.logEvents!;
  assert.equal(events.length, MAX_BUFFERED + 1);
  const summary = events.map((e) => JSON.parse(e.message)).find((m) => m.type === "refusals_dropped");
  assert.equal(summary?.dropped, 7);
});

test("a CloudWatch failure never throws, and a lost stream is recreated", async () => {
  let failPut = true;
  const rec = recordingClient((k) => (k === "PutLogEventsCommand" && failPut ? named("ResourceNotFoundException") : null));
  const log = new RefusalLog({ logGroup: "/g", cellId: "0", flushMs: 60_000, client: rec.client, stream: "s" });
  log.record(line());
  await log.flush();
  failPut = false;
  log.record(line());
  await log.flush();
  assert.equal(rec.sent.filter((s) => s.kind === "CreateLogStreamCommand").length, 2);
  assert.equal(rec.puts().length, 2);
});

test("stop() flushes what is buffered", async () => {
  const rec = recordingClient();
  const log = new RefusalLog({ logGroup: "/g", cellId: "0", flushMs: 60_000, client: rec.client, stream: "s" });
  log.start();
  log.record(line());
  await log.stop();
  assert.equal(rec.puts().length, 1);
});

test("audit() hands ONLY refusals to the sink", () => {
  const seen: AuditLine[] = [];
  setRefusalSink((l) => seen.push(l));
  const log = console.log;
  console.log = () => {};
  try {
    audit(line({ allowed: true, code: undefined }));
    audit(line());
  } finally {
    console.log = log;
    setRefusalSink(null);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.code, "SQL_ERROR");
});
