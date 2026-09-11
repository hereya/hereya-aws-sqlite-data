import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Re-anchored: this module sits one directory below the worker-host barrel, so
// the candidates are resolved against service/src/ (where sql-worker lives),
// not against this directory.
const HOST_DIR = new URL("../", import.meta.url);

export function resolveWorkerPath(): string {
  for (const candidate of ["./sql-worker.js", "./sql-worker.ts"]) {
    const p = fileURLToPath(new URL(candidate, HOST_DIR));
    if (existsSync(p)) return p;
  }
  throw new Error("sql-worker entry not found next to worker-host");
}
