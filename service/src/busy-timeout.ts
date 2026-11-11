/**
 * How long a statement waits for SQLite's write lock before it fails
 * "database is locked". ONE number, used on both sides of the process
 * boundary: the worker sets it as `PRAGMA busy_timeout` on every connection
 * (sql-worker.ts), and the parent holds an autocommit write behind an open
 * transaction for exactly as long (worker-host/tx-hold.ts) — so that a write
 * which cannot get the lock is answered the same way, after the same time,
 * whichever side did the waiting.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** SQLite's own message for SQLITE_BUSY, as the worker reports it. */
export const BUSY_MESSAGE = "database is locked";
