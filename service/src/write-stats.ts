// When did each app last CHANGE its database?
//
// This is the number every remaining optimisation waits on: the eviction
// threshold (how long without a write before an app leaves the replication
// set), which apps belong on a slow-cadence litestream process, and the
// anti-abuse creation limit all need the DISTRIBUTION of write-idleness per
// app — not its average.
//
// It could not be obtained from the replica bucket: every VM roll makes
// litestream snapshot each database, which stamps a fresh L0 file and floors
// the signal at "last boot". On 2026-08-24 four rolls in one day erased it four
// times; 58 of 61 apps showed a last write inside the same two-minute window,
// twenty-five minutes after a deploy. Waiting for a quiet week is betting
// against our own release rhythm.
//
// THE VM IS THE ONLY PLACE THIS CAN BE COUNTED. A per-app frontend Lambda
// writes to the Data API directly with its own capability token, so the
// connector never sees those statements — but they all land here.
//
// Design constraints, in order of importance:
//
//  1. It sits on the write path, so it must NEVER be able to fail a customer's
//     write. The hot path is a single Map.set — no I/O, no await, nothing that
//     can throw. Persistence happens on a background timer, and a failed flush
//     costs resolution, never data.
//  2. It must survive instance replacement, which is exactly what the S3
//     timestamps did not.
//  3. It must not widen what the data plane can reach. Rows live in a FIXED
//     `_writestats` partition of the registry table (the same trick the
//     connector uses for `_hosts` and `_catalog` — org ids are UUIDs, so the
//     literal can never collide), and the instance role's write grant is
//     conditioned on that partition key alone. The VM still cannot touch a
//     single org or app row.
//
// "A write" means the statement CHANGED the database (`info.changes > 0`).
// That is deliberately the same definition litestream reacts to: a statement
// touching zero rows produces no LTX file and costs no replication, so counting
// it would measure something other than what we are trying to price.
//
// The code lives in `write-stats/`: `keys.ts` (the fixed partition and the
// observation key), `stat.ts` (the entry shape and the pure flush policy),
// `counter.ts` (the in-memory hot paths and readers) and `store.ts` (the
// DynamoDB half). This file is the barrel every importer keeps using.
export { OBSERVING_SINCE_KEY, WRITE_STATS_PARTITION } from "./write-stats/keys.ts";
export { markOf, pendingSince, statKey } from "./write-stats/stat.ts";
export type { FlushedMark, WriteStat } from "./write-stats/stat.ts";
export { WriteStatsCounter } from "./write-stats/counter.ts";
export { WriteStats } from "./write-stats/store.ts";
