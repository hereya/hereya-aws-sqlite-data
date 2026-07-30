// What identifies a build of the Data API service — and therefore WHEN the
// production database VM is allowed to be replaced.
//
// The instance roll is deliberate (see the ASG updatePolicy: terminate-before-
// launch is the only order compatible with litestream's single-writer rule), so
// the artifact hash is not bookkeeping — it is the trigger for a ~1 minute
// outage of every app's database. It must therefore answer exactly one
// question: "is this a different service than the one currently running?"
//
// It used to answer "is this a different BUILD?" — the asset hash was computed
// on the bundling OUTPUT (`AssetHashType.OUTPUT`), i.e. on `service.tar.gz`,
// and that tarball is not reproducible: `version.json` carries a `builtAt`
// timestamp and tar/gzip record mtimes. Two builds of identical source produced
// two different hashes (verified 2026-07-30: 0d22abda… then b7ef4c8e…), so the
// launch template changed on EVERY deploy and CloudFormation rolled the
// database VM every time — five replacements in forty hours, none of them
// caused by a change to this service. Each cost ~60 s during which the Data API
// was unreachable and visitors of customer sites were logged out.
//
// So: hash the INPUTS instead. Everything that genuinely determines what runs
// on the box — the service sources, the build script that turns them into the
// artifact, and the pinned Node / litestream / sqlite-vec versions it downloads.
// Anything else (a rebuild, a timestamp, a deploy of an unrelated component)
// leaves the hash alone, and the database keeps serving.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories inside `service/` that never reach the artifact. */
const IGNORED_DIRS = new Set(["node_modules", "dist", ".toolchain", "coverage"]);

/** Files outside `service/` that still change what the artifact contains. A
 *  litestream bump must roll the instance — that IS a different service. */
const EXTRA_INPUTS = [
  join("scripts", "build-service.mjs"),
  join("scripts", "node-version.txt"),
  join("scripts", "litestream-version.txt"),
  join("scripts", "sqlite-vec-version.txt"),
  join("scripts", "pins.json"),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * A stable sha256 over the service's real inputs. Same sources + same pins =
 * same hash, on any machine, at any time — which is what keeps an unrelated
 * deploy from taking the databases down.
 *
 * Paths are normalized to `/` so a build on another OS agrees, and each file
 * contributes both its path and its bytes (renaming a file must change the
 * hash). A missing optional input contributes its absence rather than throwing:
 * `pins.json` legitimately does not exist before the first fetch.
 */
export function serviceContentHash(repoRoot: string): string {
  const h = createHash("sha256");
  const serviceDir = join(repoRoot, "service");
  for (const file of walk(serviceDir)) {
    h.update(relative(repoRoot, file).split(sep).join("/"));
    h.update("\0");
    h.update(readFileSync(file));
    h.update("\0");
  }
  for (const rel of EXTRA_INPUTS) {
    const abs = join(repoRoot, rel);
    h.update(rel.split(sep).join("/"));
    h.update("\0");
    let exists = false;
    try {
      exists = statSync(abs).isFile();
    } catch {
      exists = false;
    }
    h.update(exists ? readFileSync(abs) : Buffer.from("<absent>"));
    h.update("\0");
  }
  return h.digest("hex");
}
