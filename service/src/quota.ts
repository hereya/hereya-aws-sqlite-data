// Database quota — the LAST path a cap could not reach.
//
// dilaya.eu decides `maxDbMb`; the connector caches it on the registry's org
// row and enforces it on the paths IT drives (agent `execute`, bulk-insert).
// But a deployed per-app Lambda talks to this service DIRECTLY with its own
// capability token — the connector is not in that loop, so those writes were
// invisible to the cap. This module closes that hole where the bytes actually
// land: on the VM that owns the files.
//
// It follows the connector's doctrine (dilaya-connector/src/quotas.ts) rather
// than inventing a second one:
//
//   * `null`/absent/unreadable = NO cap. Quotas FAIL OPEN — the opposite of the
//     registry lookup right next to it, and deliberately so: that one answers
//     "may this caller touch this app" (a security question, fail closed), this
//     one answers "has this customer bought enough space" (a commercial one).
//     Refusing an org's own writes because DynamoDB blinked would be a far
//     worse failure than not enforcing a cap for one more request.
//   * NOTHING IS EVER DELETED. Over the cap refuses the NEXT write and says
//     what to do; every byte stays readable and downloadable.
//   * Reads and space-FREEING statements always pass (DELETE / DROP / VACUUM).
//     The refusal tells the person to free space, so refusing the statements
//     that free it would lock them in a room whose key we just handed them.
//   * Measure, don't accumulate. Usage is the real size of the org's files on
//     this disk — no ledger to drift out of sync, and a customer who frees
//     space is unblocked by the next refresh. Cached with a short TTL that
//     tightens as the org approaches its cap (see measureTtlMs).
//   * Check-then-act. The overshoot is bounded by one in-flight statement plus
//     whatever lands inside the cache window — caps here are commercial, not
//     safety-critical.
//   * An UNCAPPED org pays exactly one cached DynamoDB read and never a
//     filesystem walk.
//
// Where this differs from the connector, on purpose: for a multi-statement
// script the connector looks at the head only, while here EVERY statement must
// be exempt for the script to pass. Being stricter costs nothing (the check
// only runs for an org already over its cap) and closes the obvious
// "DELETE …; INSERT …" bypass.
//
// The code lives in ./quota/ — this file is the stable entry point.
export { MB, humanBytes, measureTtlMs, overQuota, sqlSkipsQuota } from "./quota/policy.ts";
export { DdbOrgQuotaReader, StaticOrgQuotaReader, type OrgQuotaReader } from "./quota/readers.ts";
export { measureOrgDbBytes } from "./quota/measure.ts";
export { DbQuotaGuard } from "./quota/guard.ts";
