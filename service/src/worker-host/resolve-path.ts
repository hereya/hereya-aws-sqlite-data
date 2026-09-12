import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// WHERE IS sql-worker? The answer is different in the SOURCE TREE and in the
// SHIPPED BUNDLE, and that is the whole difficulty.
//
// In source, this module sits at service/src/worker-host/resolve-path.ts and
// the worker is one directory up, at service/src/sql-worker.ts. In the artifact
// the VM actually runs, esbuild has melted every module into a single
// /opt/dilaya/service/main.js — so `import.meta.url` points at main.js and the
// worker sits RIGHT NEXT TO IT, not one directory up.
//
// ⚠️ THIS COST A PRODUCTION OUTAGE (2026-09-12, ~30 min, every customer app's
// data unreachable). The 220-line split (#38) moved this code one directory
// deeper and "re-anchored" it with `../`, which is correct for the source tree
// and wrong for the bundle. It could not be caught by anything that runs from
// source — the tests, the typecheck, the synth all pass — and it does not
// detonate at deploy either: the running VM keeps its older artifact. It waits
// for the next INSTANCE REPLACEMENT, which came with an AMI roll.
//
// So both anchors are tried, in both layouts. Costs two `existsSync` at boot
// and removes an entire class of "works from source, dies in the bundle".
const ANCHORS = [
  new URL("./", import.meta.url), // bundled: next to main.js
  new URL("../", import.meta.url), // source: service/src/, one above this file
];

export function resolveWorkerPath(): string {
  for (const anchor of ANCHORS) {
    for (const candidate of ["./sql-worker.js", "./sql-worker.ts"]) {
      const p = fileURLToPath(new URL(candidate, anchor));
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    `sql-worker entry not found — looked next to, and one directory above, ${fileURLToPath(ANCHORS[0]!)}`
  );
}
