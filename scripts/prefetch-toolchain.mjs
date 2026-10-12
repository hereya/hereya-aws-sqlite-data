// Fills `.toolchain/artifact-cache` BEFORE scripts/build-service.mjs runs, so the
// build never has to download anything itself.
//
// Why a separate step and not a change to build-service.mjs: that script is one
// of the hashed INPUTS of the service (lib/service-hash.ts) — editing it changes
// the launch template and REPLACES the production database VM. How the archives
// are fetched does not change what runs on the box, so it lives here, outside
// the hash. build-service.mjs simply finds its archives already in the cache
// (and still verifies every one against scripts/pins.json).
//
// Sources, in order, each sha256-verified against the pin:
//   1. the cache          — warm on an executor that already built this version
//   2. the MIRROR         — a sha-addressed copy in the account's own S3 (the CDK
//                           assets bucket the service artifact is uploaded to),
//                           so a deploy or a ROLLBACK no longer needs GitHub or
//                           nodejs.org to be up at that moment (12/10/2026: a
//                           GitHub 504 at synth failed a release's first attempt)
//   3. the public URL     — with retry on 5xx / network errors (3 retries:
//                           1 s, 4 s, 10 s); the bytes are written THROUGH to
//                           the mirror, which is how the mirror gets seeded
//
// Everything here is best-effort: a failure is logged and the step returns.
// build-service.mjs keeps its own single fetch as the last resort, so this
// script can only make a deploy more likely to succeed, never make it fail.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RETRY_DELAYS_MS = [1000, 4000, 10000];
export const DEFAULT_MIRROR_PREFIX = "toolchain-mirror";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The three pinned archives build-service.mjs bundles: same file names, same
 *  pin keys. A drift between the two files is only a cache miss (build-service
 *  downloads as before) — never a wrong artifact, the sha256 pins hold. */
export function pinnedAssets(root = DEFAULT_ROOT) {
  const read = (f) => readFileSync(join(root, "scripts", f), "utf8").trim();
  const node = read("node-version.txt");
  const ls = read("litestream-version.txt");
  const vec = read("sqlite-vec-version.txt");
  const lsAsset = /^v0\.[5-9]|^v[1-9]/.test(ls) ? ls.replace(/^v/, "") : ls;
  const vecAsset = vec.replace(/^v/, "");
  const nodeName = `node-${node}-linux-arm64.tar.xz`;
  const lsName = `litestream-${lsAsset}-linux-arm64.tar.gz`;
  const vecName = `sqlite-vec-${vecAsset}-loadable-linux-aarch64.tar.gz`;
  return [
    { name: nodeName, url: `https://nodejs.org/dist/${node}/${nodeName}`, pinKey: `node:${node}:linux-arm64` },
    {
      name: lsName,
      url: `https://github.com/benbjohnson/litestream/releases/download/${ls}/${lsName}`,
      pinKey: `litestream:${ls}:linux-arm64`,
    },
    {
      name: vecName,
      url: `https://github.com/asg017/sqlite-vec/releases/download/${vec}/${vecName}`,
      pinKey: `sqlite-vec:${vec}:linux-arm64`,
    },
  ];
}

export function readPins(root = DEFAULT_ROOT) {
  const p = join(root, "scripts", "pins.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Where the mirror lives. `TOOLCHAIN_MIRROR=s3://bucket[/prefix]` names it
 *  explicitly, `off` disables it; otherwise it is the CDK bootstrap assets
 *  bucket of the account/region being synthesized for — the bucket the service
 *  artifact itself lands in, so it exists wherever this stack can deploy. No
 *  account/region in the environment (a bare local synth) = no mirror. */
export function mirrorLocation(env = process.env) {
  const explicit = env.TOOLCHAIN_MIRROR;
  if (explicit === "off") return null;
  const region = env.CDK_DEFAULT_REGION ?? env.AWS_REGION;
  if (explicit) {
    const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(explicit);
    if (!m || !region) return null;
    return { bucket: m[1], prefix: m[2].replace(/\/+$/, "") || DEFAULT_MIRROR_PREFIX, region };
  }
  const account = env.CDK_DEFAULT_ACCOUNT;
  if (!account || !region) return null;
  const qualifier = env.CDK_QUALIFIER ?? "hnb659fds";
  return { bucket: `cdk-${qualifier}-assets-${account}-${region}`, prefix: DEFAULT_MIRROR_PREFIX, region };
}

const isMissing = (e) => ["NoSuchKey", "NotFound"].includes(e?.name) || e?.$metadata?.httpStatusCode === 404;

async function s3Store(region) {
  const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region });
  return {
    async get(Bucket, Key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async has(Bucket, Key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key }));
        return true;
      } catch (e) {
        if (isMissing(e)) return false;
        throw e;
      }
    },
    async put(Bucket, Key, Body) {
      await client.send(new PutObjectCommand({ Bucket, Key, Body }));
    },
  };
}

/** One download with retry on what a short outage looks like (5xx, 429, a
 *  network error). A 4xx is a wrong URL, not an outage: no retry. */
export async function fetchWithRetry(url, { fetchImpl = fetch, delays = RETRY_DELAYS_MS, sleep = defaultSleep, log = console.log } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res, err;
    try {
      res = await fetchImpl(url, { redirect: "follow" });
    } catch (e) {
      err = e;
    }
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
    const reason = err ? (err.cause?.code ?? err.message) : `HTTP ${res.status}`;
    const retryable = err !== undefined || res.status >= 500 || res.status === 429;
    if (!retryable || attempt > delays.length) throw new Error(`download failed after ${attempt} attempt(s): ${reason} ${url}`);
    log(`toolchain: ${reason} on ${url} — retry ${attempt}/${delays.length} in ${delays[attempt - 1]} ms`);
    await sleep(delays[attempt - 1]);
  }
}

/** Fills the cache for every pinned asset; returns one report row per asset
 *  ({ name, source: 'cache'|'mirror'|'public'|null, mirrored }). Never throws. */
export async function prefetchToolchain({ root = DEFAULT_ROOT, env = process.env, store, fetchImpl = fetch, sleep, log = console.log } = {}) {
  const cacheDir = join(root, ".toolchain", "artifact-cache");
  mkdirSync(cacheDir, { recursive: true });
  const pins = readPins(root);
  const mirror = mirrorLocation(env);
  let s3 = null;
  if (mirror) {
    try {
      s3 = store ?? (await s3Store(mirror.region));
    } catch (e) {
      log(`toolchain: mirror s3://${mirror.bucket}/${mirror.prefix} unavailable (${e?.message ?? e}) — public URLs only`);
    }
  } else log("toolchain: no mirror configured (no CDK account/region in the environment) — public URLs only");
  const report = [];
  for (const asset of pinnedAssets(root)) {
    const expected = pins[asset.pinKey];
    const cached = join(cacheDir, asset.name);
    const verified = (buf) => expected === undefined || sha256(buf) === expected;
    const key = expected !== undefined && mirror ? `${mirror.prefix}/${expected}/${asset.name}` : null;
    let buf = null;
    let source = null;
    if (existsSync(cached)) {
      const b = readFileSync(cached);
      if (verified(b)) [buf, source] = [b, "cache"];
      else rmSync(cached, { force: true });
    }
    if (!buf && key && s3) {
      try {
        const b = await s3.get(mirror.bucket, key);
        if (b && verified(b)) [buf, source] = [b, "mirror"];
        else if (b) log(`toolchain: mirror copy of ${asset.name} fails its sha256 — ignored`);
      } catch (e) {
        log(`toolchain: mirror read failed for ${asset.name} (${e?.message ?? e})`);
      }
    }
    if (!buf) {
      try {
        const b = await fetchWithRetry(asset.url, { fetchImpl, sleep, log });
        if (verified(b)) [buf, source] = [b, "public"];
        else log(`toolchain: ${asset.url} fails its sha256 pin — left to build-service.mjs`);
      } catch (e) {
        log(`toolchain: ${e?.message ?? e} — left to build-service.mjs`);
      }
    }
    if (buf && source !== "cache") writeFileSync(cached, buf);
    let mirrored = false;
    if (buf && key && s3) {
      try {
        if (!(await s3.has(mirror.bucket, key))) {
          await s3.put(mirror.bucket, key, buf);
          mirrored = true;
        }
      } catch (e) {
        log(`toolchain: mirror write failed for ${asset.name} (${e?.message ?? e})`);
      }
    }
    log(`toolchain: ${asset.name} <- ${source ?? "nothing (build-service.mjs will download)"}${mirrored ? ", copied to the mirror" : ""}`);
    report.push({ name: asset.name, source, mirrored });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prefetchToolchain();
  } catch (e) {
    console.log(`toolchain: prefetch failed (${e?.message ?? e}) — build-service.mjs will download directly`);
  }
}
