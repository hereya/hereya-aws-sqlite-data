import { ServiceError } from "../errors.ts";

// ---------------------------------------------------------------------------
// SQL guards. The connector applies the same rules; this layer must reject
// independently (defense in depth — spec §6).
// ---------------------------------------------------------------------------

/** Strips string literals, quoted identifiers, and comments so keyword scans can't be fooled. */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : "";
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      // x'ff' blob literals are covered: the x stays, the quoted part is stripped.
      const quote = c;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // escaped quote
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
    } else if (c === "[") {
      const end = sql.indexOf("]", i);
      i = end === -1 ? n : end + 1;
      out += " ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const READONLY_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "foreign_key_list",
  "index_list",
  "index_info",
  "index_xinfo",
]);

/**
 * Rejects SQL that could escape the per-app database file or mutate engine
 * state: ATTACH/DETACH, VACUUM INTO, and any PRAGMA outside a small read-only
 * introspection allowlist.
 */
export function assertSafeSql(sql: string): void {
  const stripped = stripSqlLiterals(sql);
  if (/\b(ATTACH|DETACH)\b/i.test(stripped)) {
    throw new ServiceError("SQL_FORBIDDEN", "ATTACH/DETACH are not allowed");
  }
  if (/\bVACUUM\b[^;]*\bINTO\b/i.test(stripped)) {
    throw new ServiceError("SQL_FORBIDDEN", "VACUUM INTO is not allowed");
  }
  const pragmaRe = /\bPRAGMA\b\s*([A-Za-z_][A-Za-z0-9_]*)?\s*(.)?/gi;
  let m: RegExpExecArray | null;
  while ((m = pragmaRe.exec(stripped)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    const after = m[2] ?? "";
    if (!READONLY_PRAGMAS.has(name) || after !== "(") {
      throw new ServiceError(
        "SQL_FORBIDDEN",
        `PRAGMA is limited to read-only introspection: ${[...READONLY_PRAGMAS].join(", ")} (call form only)`,
      );
    }
  }
}

/** True when the (stripped) SQL contains more than one statement. */
export function isMultiStatement(sql: string): boolean {
  const stripped = stripSqlLiterals(sql);
  const idx = stripped.indexOf(";");
  if (idx === -1) return false;
  return /\S/.test(stripped.slice(idx + 1));
}
