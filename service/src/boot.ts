// Strict boot order (spec §4): read registry → restore EVERY active app →
// bind the HTTP API → start litestream replication → background loops → ready.
// Any restore failure aborts the boot — never serve partially restored.
// Implementation lives in ./boot/; this file is the stable import surface.
export { createOrgQuotaReader, createRegistry } from "./boot/deps.ts";
export { bootService } from "./boot/service.ts";
export type { RunningService } from "./boot/types.ts";
