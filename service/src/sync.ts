// Barrel: the served set and the operations over it live in ./sync/.
//
// `AppSync` (./sync/app-sync.ts) is the facade; the state it owns is in
// ./sync/state.ts, and each operation carries its own reasoning —
// ./sync/boot-restore.ts, ./sync/ensure-served.ts, ./sync/evict.ts,
// ./sync/reconcile.ts.
export { AppSync } from "./sync/app-sync.ts";
export type { TouchSink } from "./sync/touch-sink.ts";
