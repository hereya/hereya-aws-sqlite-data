// Downloads the pinned sqlite-vec loadable extension to .toolchain/vec0.<ext>
// for local dev/tests. The production artifact bundles the linux-arm64 build
// with an explicit sha256 at build time (scripts/build-service.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolchainDir = join(root, ".toolchain");
const stampFile = join(toolchainDir, "sqlite-vec.version");

const VERSION = readFileSync(join(root, "scripts", "sqlite-vec-version.txt"), "utf8").trim();

// Release assets: sqlite-vec-0.1.9-loadable-{macos,linux}-{aarch64,x86_64}.tar.gz
// (bare version in the asset name; the archive contains vec0.{dylib,so}).
const platform = process.platform === "darwin" ? "macos" : "linux";
const archName = process.arch === "arm64" ? "aarch64" : "x86_64";
const libName = platform === "macos" ? "vec0.dylib" : "vec0.so";
const libPath = join(toolchainDir, libName);
const assetVersion = VERSION.replace(/^v/, "");
const asset = `sqlite-vec-${assetVersion}-loadable-${platform}-${archName}.tar.gz`;
const url = `https://github.com/asg017/sqlite-vec/releases/download/${VERSION}/${asset}`;

function ok() {
  return existsSync(libPath) && existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === `${VERSION}-${platform}-${archName}`;
}

async function main() {
  if (ok()) return;
  mkdirSync(toolchainDir, { recursive: true });
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const archivePath = join(toolchainDir, asset);
  writeFileSync(archivePath, buf);
  const extractDir = join(toolchainDir, "vec-extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
  rmSync(libPath, { force: true });
  execFileSync("mv", [join(extractDir, libName), libPath]);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  writeFileSync(stampFile, `${VERSION}-${platform}-${archName}`);
  console.log(`sqlite-vec ${VERSION} ready at ${libPath}`);
}

await main();
