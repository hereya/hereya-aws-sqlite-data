// The worker must be FOUND FROM THE BUNDLE, not only from the sources.
//
// ⚠️ PRODUCTION OUTAGE, 2026-09-12, ~20 min, every customer app's data
// unreachable. The 220-line split (#38) moved `resolveWorkerPath` one directory
// deeper and anchored it on `new URL("../", import.meta.url)`. Correct in the
// source tree — the worker IS one level up there. Wrong in the shipped
// artifact: esbuild melts every module into a single `main.js`, so
// `import.meta.url` is main.js and `../` points ABOVE the service directory.
// The VM died at boot: "sql-worker entry not found next to worker-host".
//
// Nothing that runs from source could see it — the unit tests, the typecheck
// and the synth were all green — and a deploy does not reveal it either,
// because the running VM keeps its older artifact. It waited two days for the
// next INSTANCE REPLACEMENT.
//
// So this test does what every other one skips: it BUILDS the bundle the way
// scripts/build-service.mjs does (same esbuild options, entry at the same
// depth as service/src/main.ts), lays it out like /opt/dilaya/service, and
// RUNS it. No download — the Node, litestream and vec0 tarballs are irrelevant
// to where the worker is looked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "service", "src");

/**
 * Build a `main.js` whose only job is to print `resolveWorkerPath()`, from an
 * entry that lives — for esbuild — in service/src/, exactly like main.ts. The
 * options mirror scripts/build-service.mjs, banner included.
 */
async function bundleProbe(serviceDir: string): Promise<void> {
  await build({
    stdin: {
      contents:
        'import { resolveWorkerPath } from "./worker-host.ts";\n' +
        "console.log(resolveWorkerPath());\n",
      resolveDir: srcDir,
      sourcefile: "main.ts",
      loader: "ts",
    },
    outfile: join(serviceDir, "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  writeFileSync(join(serviceDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");
}

function runProbe(serviceDir: string): string {
  return execFileSync(process.execPath, [join(serviceDir, "main.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("the BUNDLED service finds sql-worker.js sitting next to main.js — the layout of /opt/dilaya/service", async () => {
  const serviceDir = mkdtempSync(join(tmpdir(), "dilaya-service-"));
  try {
    await bundleProbe(serviceDir);
    // The real worker, bundled the same way, beside main.js.
    await build({
      entryPoints: [join(srcDir, "sql-worker.ts")],
      outdir: serviceDir,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
    // realpath on both sides: on macOS the temp dir lives under /var, a symlink
    // to /private/var, and the bundle resolves through it. Comparing a resolved
    // path to an unresolved one fails for a reason that has nothing to do with
    // where the worker is — which is exactly the false signal this test exists
    // to avoid.
    assert.equal(
      realpathSync(runProbe(serviceDir)),
      realpathSync(join(serviceDir, "sql-worker.js"))
    );
  } finally {
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test("control: with no worker beside it, the bundle still refuses loudly instead of guessing", async () => {
  const serviceDir = mkdtempSync(join(tmpdir(), "dilaya-service-"));
  try {
    await bundleProbe(serviceDir);
    assert.throws(() => runProbe(serviceDir), /sql-worker entry not found/);
  } finally {
    rmSync(serviceDir, { recursive: true, force: true });
  }
});
