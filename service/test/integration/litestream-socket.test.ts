// A database joins or leaves the RUNNING daemon — real litestream, file://
// replicas. What is pinned here is the point of the control socket: adding or
// dropping one database must not restart replication for the others (the pid
// is the witness), and when the socket cannot be used the bounce still
// converges on the same set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.ts";
import { Litestream, type LitestreamApp } from "../../src/litestream.ts";

const litestreamBin = fileURLToPath(new URL("../../../.toolchain/litestream", import.meta.url));
const haveLitestream = existsSync(litestreamBin);

interface Env {
  ls: Litestream;
  dir: string;
  socket: string;
  app: (id: string) => LitestreamApp;
  listed: () => string[];
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "ls-sock-"));
  const cfg = loadConfig({
    LITESTREAM_BIN: litestreamBin,
    LITESTREAM_CONFIG_PATH: join(dir, "litestream.yml"),
    REPLICA_BASE_URL: `file://${join(dir, "replicas")}`,
    LITESTREAM_SYNC_INTERVAL_MS: "150",
  } as NodeJS.ProcessEnv);
  assert.ok(cfg.litestreamSocketPath, "the temp dir must leave room for a socket path");
  const app = (id: string): LitestreamApp => {
    const dbPath = join(dir, "dbs", "org", id, "app.db");
    if (!existsSync(dbPath)) {
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);");
      db.close();
    }
    return { orgId: "org", appId: id, dbPath };
  };
  const listed = (): string[] => {
    const out = execFileSync(litestreamBin, ["list", "-json", "-socket", cfg.litestreamSocketPath]).toString();
    const dbs = (JSON.parse(out) as { databases: Array<{ path: string }> | null }).databases ?? [];
    return dbs.map((d) => d.path.split("/").at(-2)!).sort();
  };
  return { ls: new Litestream(cfg), dir, socket: cfg.litestreamSocketPath, app, listed };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test("a database joins and leaves without restarting the daemon", { skip: !haveLitestream }, async () => {
  const env = makeEnv();
  try {
    env.ls.start([env.app("a")]);
    assert.ok(await waitFor(() => existsSync(env.socket)), "the daemon must open its control socket");
    const pid = env.ls.childPid;
    assert.ok(pid);

    await env.ls.apply([env.app("a"), env.app("b")]);
    assert.equal(env.ls.childPid, pid, "adding b must not restart replication of a");
    assert.deepEqual(env.listed(), ["a", "b"]);
    assert.ok(
      await waitFor(() => existsSync(join(env.dir, "replicas", "org", "b", "app.db"))),
      "b must actually be replicated, not merely listed",
    );

    await env.ls.apply([env.app("a")]);
    assert.equal(env.ls.childPid, pid, "dropping b must not restart replication of a");
    assert.deepEqual(env.listed(), ["a"]);
    assert.equal(env.ls.healthy, true);
  } finally {
    await env.ls.stop();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("an unusable socket falls back to the bounce, and converges", { skip: !haveLitestream }, async () => {
  const env = makeEnv();
  try {
    env.ls.start([env.app("a")]);
    assert.ok(await waitFor(() => existsSync(env.socket)));
    const pid = env.ls.childPid;
    // The daemon keeps running, but nothing can reach it any more.
    rmSync(env.socket);

    await env.ls.apply([env.app("a"), env.app("b")]);
    assert.notEqual(env.ls.childPid, pid, "the fallback is a restart");
    assert.ok(await waitFor(() => existsSync(env.socket)));
    assert.deepEqual(env.listed(), ["a", "b"], "the restarted daemon watches the full set");
  } finally {
    await env.ls.stop();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("the last database leaving stops the daemon; the next one starts it", { skip: !haveLitestream }, async () => {
  const env = makeEnv();
  try {
    env.ls.start([env.app("a")]);
    assert.ok(await waitFor(() => existsSync(env.socket)));
    await env.ls.apply([]);
    assert.equal(env.ls.childPid, null);
    assert.equal(env.ls.healthy, true, "nothing to replicate is healthy");

    await env.ls.apply([env.app("b")]);
    assert.ok(env.ls.childPid);
    assert.ok(await waitFor(() => existsSync(env.socket)));
    assert.deepEqual(env.listed(), ["b"]);
  } finally {
    await env.ls.stop();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
