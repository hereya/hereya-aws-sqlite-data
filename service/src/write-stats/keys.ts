/** The fixed partition. Org ids are UUIDs, so this literal cannot collide. */
export const WRITE_STATS_PARTITION = "_writestats";

/**
 * The sort key holding WHEN THIS COUNTER FIRST STARTED WATCHING.
 *
 * Every app row's sort key is `<orgId>/<appId>` and therefore contains a
 * slash; this one does not, so it can never be mistaken for an app — the same
 * argument that makes the partition literal safe, one level down.
 *
 * It exists because "never seen writing" is ambiguous, and the ambiguity has a
 * clock. On the day the counter shipped it means "we know nothing". After the
 * counter has watched for longer than the eviction threshold it means
 * something quite different: nothing wrote for that whole period. Without a
 * durable start date the two are indistinguishable forever, and an app that
 * never writes — the very one that costs the VM the most — can never be
 * evicted. See `planEviction`, which is the only reader.
 *
 * Durability is the whole point, and it is why this lives in DynamoDB next to
 * the counters rather than in memory: an instance replacement must not restart
 * the observation. That is exactly the trap that forced the counters
 * themselves out of the replica bucket (four VM rolls on 2026-08-24).
 */
export const OBSERVING_SINCE_KEY = "_since";
