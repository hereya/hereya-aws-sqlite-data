// Hereya package inputs arrive as plain env vars (camelCase).
export function input(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
