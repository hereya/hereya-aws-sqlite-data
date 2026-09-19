// Phase 0 proof (t_dbmove_p0_trial): per-database Litestream moves on S3, linux/arm64, 100 dbs.
// Runs ON the disposable trial VM, beside (not inside) the data service: two standalone
// litestream daemons A and B with control sockets, replicating under s3://<bucket>/_p0trial/.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const BUCKET = process.argv[2];
const BIG_MB = Number(process.argv[3] ?? 500);
const N = 100;
const LS = process.env.P0_LS ?? "/usr/local/bin/litestream";
const ROOT = process.env.P0_ROOT ?? "/var/lib/p0";
const RUN = `_p0trial/${Date.now()}`;
const url = (name) => `${process.env.P0_BASE ?? `s3://${BUCKET}`}/${RUN}/${name}/app.db`;
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { bucket: BUCKET, run: RUN, bigMb: BIG_MB, small: [], big: null, bystanders: null, verify: [] };
const log = (o) => console.log(JSON.stringify(o));

const ls = (args, opts = {}) => execFileSync(LS, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const timed = (fn) => { const t = now(); const r = fn(); return [now() - t, r]; };

function open(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  return db;
}
function write(path, v) { const db = open(path); db.prepare("INSERT INTO t(v) VALUES(?)").run(v); db.close(); }
function values(path) { const db = new DatabaseSync(path, { readOnly: true }); const r = db.prepare("SELECT v FROM t WHERE v NOT LIKE 'seed%'").all().map((x) => x.v); db.close(); return r; }

function config(sock, dbs) {
  const l = ["l0-retention: 3h", "l0-retention-check-interval: 30m", "levels:", "  - interval: 30m", "  - interval: 2h", "  - interval: 6h",
    "snapshot:", "  interval: 6h", "  retention: 72h", "socket:", "  enabled: true", `  path: ${sock}`, "dbs:"];
  for (const d of dbs) l.push(`  - path: ${d.path}`, "    replica:", `      url: ${d.url}`, "      sync-interval: 1000ms");
  if (dbs.length === 0) l.push("  []");
  return l.join("\n") + "\n";
}
function daemon(name, dbs) {
  const cfg = `${ROOT}/${name}.yml`;
  writeFileSync(cfg, config(`${name}.sock`, dbs));
  const child = spawn(LS, ["replicate", "-config", cfg], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  for (const s of [child.stdout, child.stderr]) s.on("data", (c) => lines.push(...c.toString().split("\n").filter(Boolean)));
  return { child, lines, sock: `${name}.sock` };
}
const rss = (pid) => { try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024; } catch { return null; } };

rmSync(ROOT, { recursive: true, force: true });
for (const d of ["A", "B", "C"]) mkdirSync(`${ROOT}/${d}`, { recursive: true });
process.chdir(ROOT);
log({ step: "versions", litestream: ls(["version"]).trim(), node: process.version });

// 1. seed: 99 small dbs + 1 big
const names = Array.from({ length: N }, (_, i) => `db${String(i).padStart(3, "0")}`);
const BIG = names[0];
const pathA = (n) => `${ROOT}/A/${n}/app.db`;
const pathB = (n) => `${ROOT}/B/${n}/app.db`;
for (const n of names) {
  mkdirSync(`${ROOT}/A/${n}`, { recursive: true }); mkdirSync(`${ROOT}/B/${n}`, { recursive: true });
  const db = open(pathA(n));
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, pad BLOB); INSERT INTO t(v) VALUES('seed');");
  if (n === BIG) {
    const rows = Math.round((BIG_MB * 1024 * 1024) / 8200);
    const ins = db.prepare("INSERT INTO t(v,pad) VALUES('seed-pad', randomblob(8000))");
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) { ins.run(); if (i % 5000 === 4999) { db.exec("COMMIT; BEGIN"); } }
    db.exec("COMMIT");
  }
  db.close();
}
out.bigBytes = statSync(pathA(BIG)).size;
log({ step: "seeded", dbs: N, bigBytes: out.bigBytes });

// 2. daemon A with all 100; daemon B empty
const A = daemon("a", names.map((n) => ({ path: pathA(n), url: url(n) })));
const B = daemon("b", []);
const tSock = now();
for (const d of [A, B]) { while (!existsSync(d.sock)) { if (d.child.exitCode !== null || now() - tSock > 900_000) { log({ step: "daemon-failed", exit: d.child.exitCode, lines: d.lines.slice(-15) }); process.exit(1); } await sleep(500); } }
out.socketReadyMs = now() - tSock;
log({ step: "sockets-ready", ms: out.socketReadyMs, aLines: A.lines.slice(0, 4).map((l) => l.slice(0, 200)) });
const [initialSyncMs] = timed(() => { for (const n of names) ls(["sync", "-wait", "-timeout", "900", "-socket", A.sock, pathA(n)]); });
out.initialSyncMs = initialSyncMs;
out.rssA_100 = rss(A.child.pid);
log({ step: "initial-sync-done", initialSyncMs, rssA: out.rssA_100, listA: ls(["list", "-socket", A.sock]).split("\n").filter(Boolean).length });

// bystanders: 5 dbs on A written every 250 ms for the whole trial — must never be disturbed
const bystanders = names.slice(90, 95);
const acked = Object.fromEntries(names.map((n) => [n, []]));
let stopBy = false; let byErrors = 0;
const byLoop = (async () => { let i = 0; while (!stopBy) { for (const n of bystanders) { try { write(pathA(n), `by-${i}`); acked[n].push(`by-${i}`); } catch { byErrors++; } } i++; await sleep(250); } })();

// 3. ten small moves, simple path: pause -> sync -wait + stop + unregister on A -> restore on B -> register on B
for (const n of names.slice(1, 11)) {
  for (let i = 0; i < 3; i++) { write(pathA(n), `A-${i}`); acked[n].push(`A-${i}`); }
  const t0 = now();
  write(pathA(n), "A-last"); acked[n].push("A-last");
  const [syncMs] = timed(() => ls(["sync", "-wait", "-socket", A.sock, pathA(n)]));
  const [stopMs, stopOut] = timed(() => ls(["stop", "-json", "-socket", A.sock, pathA(n)]));
  const [unregMs] = timed(() => ls(["unregister", "-socket", A.sock, pathA(n)]));
  const [restoreMs] = timed(() => ls(["restore", "-o", pathB(n), url(n)]));
  const [registerMs] = timed(() => ls(["register", "-replica", url(n), "-socket", B.sock, pathB(n)]));
  const pauseMs = now() - t0;
  const hasLast = values(pathB(n)).includes("A-last");
  write(pathB(n), "B-1"); acked[n].push("B-1");
  out.small.push({ n, pauseMs, syncMs, stopMs, unregMs, restoreMs, registerMs, hasLast, stop: stopOut.trim().slice(0, 200) });
  log({ step: "small-move", n, pauseMs, syncMs, stopMs, unregMs, restoreMs, registerMs, hasLast });
}

// 4. the big db, follow path: B follows while A keeps writing; cut over
{
  const n = BIG;
  const t0f = now();
  const follower = spawn(LS, ["restore", "-f", "-o", pathB(n), url(n)], { stdio: ["ignore", "pipe", "pipe"] });
  const flines = [];
  for (const s of [follower.stdout, follower.stderr]) s.on("data", (c) => flines.push(...c.toString().split("\n").filter(Boolean)));
  let i = 0; let followReadyMs = null;
  while (now() - t0f < 900_000) {
    write(pathA(n), `A-${i}`); acked[n].push(`A-${i}`); i++;
    await sleep(1000);
    if (existsSync(pathB(n))) { try { const v = values(pathB(n)); if (v.length > 0 && followReadyMs === null) followReadyMs = now() - t0f; if (followReadyMs !== null && i >= 5 && v.includes(`A-${i - 3}`)) break; } catch { /* mid-apply */ } }
  }
  const t0 = now();
  write(pathA(n), "A-last"); acked[n].push("A-last");
  const [syncMs] = timed(() => ls(["sync", "-wait", "-timeout", "120", "-socket", A.sock, pathA(n)]));
  const [stopMs] = timed(() => ls(["stop", "-socket", A.sock, pathA(n)]));
  ls(["unregister", "-socket", A.sock, pathA(n)]);
  let seenMs = null;
  while (now() - t0 < 60_000) { try { if (values(pathB(n)).includes("A-last")) { seenMs = now() - t0; break; } } catch { /* mid-apply */ } await sleep(100); }
  follower.kill("SIGTERM"); await new Promise((r) => follower.once("exit", r));
  const [registerMs] = timed(() => ls(["register", "-replica", url(n), "-socket", B.sock, pathB(n)]));
  const pauseMs = now() - t0;
  write(pathB(n), "B-1"); acked[n].push("B-1");
  out.big = { n, bytes: out.bigBytes, followReadyMs, pauseMs, syncMs, stopMs, seenOnBMs: seenMs, registerMs, followerTail: flines.slice(-3).map((l) => l.slice(0, 220)) };
  log({ step: "big-move", ...out.big });
}

// 5. let B ship, stop bystanders, final syncs
await sleep(3000);
stopBy = true; await byLoop;
const moved = [BIG, ...names.slice(1, 11)];
for (const n of moved) ls(["sync", "-wait", "-timeout", "300", "-socket", B.sock, pathB(n)]);
for (const n of bystanders) ls(["sync", "-wait", "-socket", A.sock, pathA(n)]);
out.bystanders = { dbs: bystanders.length, writeErrors: byErrors, writesEach: acked[bystanders[0]].length };
out.rssB = rss(B.child.pid); out.rssA_end = rss(A.child.pid);
out.listA = ls(["list", "-socket", A.sock]).split("\n").filter(Boolean).length;
out.listB = ls(["list", "-socket", B.sock]).split("\n").filter(Boolean).length;

// 6. verify: restore every touched db from S3 and read back every acknowledged write
for (const n of [...moved, ...bystanders]) {
  const p = `${ROOT}/C/${n}.db`;
  const [restoreMs] = timed(() => ls(["restore", "-o", p, url(n)]));
  const got = new Set(values(p));
  const missing = acked[n].filter((v) => !got.has(v));
  const db = new DatabaseSync(p, { readOnly: true }); const integrity = db.prepare("PRAGMA integrity_check").get(); db.close();
  out.verify.push({ n, acked: acked[n].length, missing: missing.length, integrity: Object.values(integrity)[0], restoreMs });
  rmSync(p, { force: true });
}
// 7. what did B write to S3 on take-over? (a fresh full snapshot, or a continued TXID chain)
const ltxOf = (n) => { try { return ls(["ltx", url(n)]).split("\n").filter(Boolean); } catch (e) { return [`ERR ${String(e.stderr ?? e).slice(0, 200)}`]; } };
out.ltxBig = ltxOf(BIG).slice(0, 25);
out.ltxSmall = ltxOf(names[1]).slice(0, 15);
out.bLog = B.lines.filter((l) => /behind|snapshot|ERROR|WARN/i.test(l)).slice(0, 25).map((l) => l.slice(0, 240));
out.aLogErrors = A.lines.filter((l) => /ERROR|WARN/i.test(l)).slice(0, 10).map((l) => l.slice(0, 240));

A.child.kill("SIGTERM"); B.child.kill("SIGTERM");
writeFileSync(`${ROOT}/result.json`, JSON.stringify(out, null, 2));
log({ step: "done", missingTotal: out.verify.reduce((s, v) => s + v.missing, 0), verified: out.verify.length });
