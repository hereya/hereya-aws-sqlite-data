/** One line per served-set event, shared by every piece of `../sync.ts`. */
export function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "sync", ...event }));
}
