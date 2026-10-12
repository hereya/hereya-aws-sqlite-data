// scripts/prefetch-toolchain.mjs fills the build cache from the S3 mirror or
// the public URLs (with retry) BEFORE build-service.mjs runs — so a deploy or a
// rollback no longer needs GitHub / nodejs.org up at synth (2026-10-12: a
// GitHub 504 at synth failed a release's first attempt). It must stay OUTSIDE
// build-service.mjs, which is a hashed input (editing it rolls the database VM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWithRetry,
  mirrorLocation,
  pinnedAssets,
  prefetchToolchain,
  readPins,
  type MirrorStore,
} from "../scripts/prefetch-toolchain.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const env = { CDK_DEFAULT_ACCOUNT: "123456789012", CDK_DEFAULT_REGION: "eu-west-1" };
const noSleep = async () => {};
const quiet = () => {};

/** A miniature repo: the three version files + pins for bytes we control. */
function fixture(bytes: Record<string, string>, pinAll = true): string {
  const dir = mkdtempSync(join(tmpdir(), "prefetch-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "node-version.txt"), "v24.17.0\n");
  writeFileSync(join(dir, "scripts", "litestream-version.txt"), "v0.5.17\n");
  writeFileSync(join(dir, "scripts", "sqlite-vec-version.txt"), "v0.1.9\n");
  if (pinAll) {
    const pins: Record<string, string> = {};
    for (const a of pinnedAssets(dir)) pins[a.pinKey] = sha(bytes[a.name] ?? a.name);
    writeFileSync(join(dir, "scripts", "pins.json"), JSON.stringify(pins));
  }
  return dir;
}
const cachePath = (dir: string, name: string) => join(dir, ".toolchain", "artifact-cache", name);

/** An in-memory S3 that records every call. */
function fakeStore(objects: Record<string, Buffer> = {}, failing = false) {
  const calls: string[] = [];
  const store: MirrorStore = {
    async get(_b, key) {
      calls.push(`get ${key}`);
      if (failing) throw new Error("AccessDenied");
      return objects[key] ?? null;
    },
    async has(_b, key) {
      calls.push(`has ${key}`);
      if (failing) throw new Error("AccessDenied");
      return key in objects;
    },
    async put(_b, key, body) {
      calls.push(`put ${key}`);
      if (failing) throw new Error("AccessDenied");
      objects[key] = body;
    },
  };
  return { store, calls, objects };
}
const publicFetch = (dir: string, log: string[] = []) =>
  (async (url: string) => {
    log.push(url);
    const asset = pinnedAssets(dir).find((a) => a.url === url);
    return new Response(asset ? asset.name : "nope", { status: asset ? 200 : 404 });
  }) as typeof fetch;

test("the pin keys match scripts/pins.json of the real repo (build-service.mjs wrote those)", () => {
  const keys = pinnedAssets(repoRoot).map((a) => a.pinKey).sort();
  assert.deepEqual(keys, Object.keys(readPins(repoRoot)).sort());
  // and the file names are the ones build-service.mjs builds (a drift = a cache miss, not a bug)
  const src = readFileSync(join(repoRoot, "scripts", "build-service.mjs"), "utf8");
  for (const tpl of ["-linux-arm64.tar.xz", "-linux-arm64.tar.gz", "-loadable-linux-aarch64.tar.gz"]) {
    assert.ok(src.includes(tpl), `build-service.mjs names an asset with ${tpl}`);
  }
});

test("mirror location: the CDK assets bucket by default, explicit s3:// URI, off, or none", () => {
  assert.deepEqual(mirrorLocation(env), { bucket: "cdk-hnb659fds-assets-123456789012-eu-west-1", prefix: "toolchain-mirror", region: "eu-west-1" });
  assert.deepEqual(mirrorLocation({ ...env, TOOLCHAIN_MIRROR: "s3://my-bucket/some/prefix/" }), { bucket: "my-bucket", prefix: "some/prefix", region: "eu-west-1" });
  assert.equal(mirrorLocation({ ...env, TOOLCHAIN_MIRROR: "off" }), null);
  assert.equal(mirrorLocation({}), null, "a bare local synth has no mirror");
});

test("fetchWithRetry: a 504 then a 504 then a 200 succeeds after the two waits", async () => {
  const statuses = [504, 504, 200];
  const waits: number[] = [];
  const fetchImpl = (async () => new Response("ok", { status: statuses.shift() })) as typeof fetch;
  const buf = await fetchWithRetry("https://x/y", { fetchImpl, sleep: async (ms) => void waits.push(ms), log: quiet });
  assert.equal(buf.toString(), "ok");
  assert.deepEqual(waits, [1000, 4000]);
});

test("fetchWithRetry: a network error retries, a 404 does not, and the retries are bounded", async () => {
  let n = 0;
  const flaky = (async () => {
    n++;
    throw new Error("fetch failed");
  }) as typeof fetch;
  await assert.rejects(fetchWithRetry("https://x/y", { fetchImpl: flaky, sleep: noSleep, log: quiet }), /after 4 attempt/);
  assert.equal(n, 4, "1 attempt + 3 retries");
  n = 0;
  const missing = (async () => {
    n++;
    return new Response("", { status: 404 });
  }) as typeof fetch;
  await assert.rejects(fetchWithRetry("https://x/y", { fetchImpl: missing, sleep: noSleep, log: quiet }), /HTTP 404/);
  assert.equal(n, 1, "a 4xx is a wrong URL, not an outage");
});

test("a mirror hit fills the cache without touching the public URL", async () => {
  const dir = fixture({});
  const objects: Record<string, Buffer> = {};
  const pins = readPins(dir);
  for (const a of pinnedAssets(dir)) objects[`toolchain-mirror/${pins[a.pinKey]}/${a.name}`] = Buffer.from(a.name);
  const { store } = fakeStore(objects);
  const urls: string[] = [];
  try {
    const rows = await prefetchToolchain({ root: dir, env, store, fetchImpl: publicFetch(dir, urls), sleep: noSleep, log: quiet });
    assert.deepEqual(rows.map((r) => r.source), ["mirror", "mirror", "mirror"]);
    assert.deepEqual(urls, []);
    for (const a of pinnedAssets(dir)) assert.equal(readFileSync(cachePath(dir, a.name), "utf8"), a.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mirror miss downloads from the public URL and writes THROUGH to the mirror (sha-addressed)", async () => {
  const dir = fixture({});
  const { store, calls, objects } = fakeStore();
  try {
    const rows = await prefetchToolchain({ root: dir, env, store, fetchImpl: publicFetch(dir), sleep: noSleep, log: quiet });
    assert.deepEqual(rows.map((r) => [r.source, r.mirrored]), [["public", true], ["public", true], ["public", true]]);
    const pins = readPins(dir);
    for (const a of pinnedAssets(dir)) {
      const key = `toolchain-mirror/${pins[a.pinKey]}/${a.name}`;
      assert.ok(calls.includes(`put ${key}`), `mirrored under its sha256: ${key}`);
      assert.equal(objects[key]?.toString(), a.name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mirror copy with the wrong sha256 is ignored; a warm cache seeds an empty mirror", async () => {
  const dir = fixture({});
  const pins = readPins(dir);
  const [first, ...rest] = pinnedAssets(dir);
  const { store, calls } = fakeStore({ [`toolchain-mirror/${pins[first!.pinKey]}/${first!.name}`]: Buffer.from("corrupt") });
  mkdirSync(join(dir, ".toolchain", "artifact-cache"), { recursive: true });
  for (const a of rest) writeFileSync(cachePath(dir, a.name), a.name);
  const urls: string[] = [];
  try {
    const rows = await prefetchToolchain({ root: dir, env, store, fetchImpl: publicFetch(dir, urls), sleep: noSleep, log: quiet });
    assert.deepEqual(rows.map((r) => r.source), ["public", "cache", "cache"]);
    assert.deepEqual(urls, [first!.url], "only the corrupt one went to the public URL");
    assert.equal(readFileSync(cachePath(dir, first!.name), "utf8"), first!.name, "the cache holds the verified bytes");
    for (const a of rest) assert.ok(calls.includes(`put toolchain-mirror/${pins[a.pinKey]}/${a.name}`), "seeded from the cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing here can fail a build: S3 denied + public down = a report, never a throw", async () => {
  const dir = fixture({});
  const { store } = fakeStore({}, true);
  const down = (async () => new Response("", { status: 503 })) as typeof fetch;
  try {
    const rows = await prefetchToolchain({ root: dir, env, store, fetchImpl: down, sleep: noSleep, log: quiet });
    assert.deepEqual(rows.map((r) => r.source), [null, null, null]);
    for (const a of pinnedAssets(dir)) assert.equal(existsSync(cachePath(dir, a.name)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unpinned version (first fetch after a bump) is downloaded but cannot be mirrored yet", async () => {
  const dir = fixture({}, false);
  const { store, calls } = fakeStore();
  try {
    const rows = await prefetchToolchain({ root: dir, env, store, fetchImpl: publicFetch(dir), sleep: noSleep, log: quiet });
    assert.deepEqual(rows.map((r) => [r.source, r.mirrored]), [["public", false], ["public", false], ["public", false]]);
    assert.deepEqual(calls, [], "no sha to address the mirror with — build-service.mjs will pin it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

