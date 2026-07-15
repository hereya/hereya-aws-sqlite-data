// sqlite-vec (vec0) loadable-extension plumbing. The extension is preloaded at
// the driver level on every app-db connection (sql-worker) and asserted at boot
// (fail-fast). Tenant SQL never gets load_extension(): node:sqlite ships with
// extension loading off, we opt in per-connection only long enough to load
// vec0, then turn it back off — the vec0 module itself stays registered.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const LIB_NAME = process.platform === "darwin" ? "vec0.dylib" : "vec0.so";

/**
 * Locate the vec0 loadable library: VEC0_PATH env when set, else next to this
 * module (the deployed artifact stages vec0.so beside main.js/sql-worker.js),
 * else the repo's .toolchain/ (dev/tests running from service/src).
 */
export function resolveVec0Path(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VEC0_PATH !== undefined && env.VEC0_PATH !== "") return env.VEC0_PATH;
  const candidates = [
    fileURLToPath(new URL(`./${LIB_NAME}`, import.meta.url)),
    fileURLToPath(new URL(`../../.toolchain/${LIB_NAME}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `sqlite-vec loadable extension not found (tried ${candidates.join(", ")}); set VEC0_PATH or run: npm run ensure-vec`,
  );
}

/** Load vec0 into an open connection, then re-disable extension loading. */
export function loadVec(db: DatabaseSync, vec0Path: string): void {
  db.loadExtension(vec0Path);
  db.enableLoadExtension(false);
}

/**
 * Boot-time self-check (fail-fast): prove the extension loads and answers on
 * this exact runtime before serving anything. Returns the vec version string.
 */
export function assertVecLoadable(vec0Path: string = resolveVec0Path()): string {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    loadVec(db, vec0Path);
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    if (typeof row?.v !== "string" || row.v === "") throw new Error("vec_version() returned no version");
    return row.v;
  } finally {
    db.close();
  }
}
