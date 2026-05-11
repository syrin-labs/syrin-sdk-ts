/** Numeric defaults, hard limits, and SSE client timing constants. */

// ---------------------------------------------------------------------------
// SDK batching / queue defaults
// ---------------------------------------------------------------------------

/** Flush the queue immediately when this many events are queued. */
export const DEFAULT_BATCH_SIZE = 100;

/** Flush if the queue is non-empty and no new events have arrived for this long (ms). */
export const DEFAULT_IDLE_FLUSH_MS = 10_000;

/** Maximum number of events queued before the oldest are dropped. */
export const DEFAULT_MAX_QUEUE_SIZE = 1000;

// ---------------------------------------------------------------------------
// HTTP timeout defaults
// ---------------------------------------------------------------------------

/** Timeout for /ingest and /health HTTP calls (ms). */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Timeout for heartbeat HTTP calls (ms). */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

/** Timeout for config-override polling GET calls (ms). */
export const DEFAULT_POLL_TIMEOUT_MS = 10_000;

/** Interval between heartbeat POSTs (ms). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Hard limits
// ---------------------------------------------------------------------------

/** Maximum characters in a governance inject_message payload. */
export const MAX_INJECT_CONTENT_LEN = 10_000;

/** Maximum characters in a checkpoint label. */
export const MAX_CHECKPOINT_LABEL_LEN = 255;

/** Maximum events per ingest batch (backend hard limit is 500; SDK caps lower). */
export const MAX_INGEST_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// SSE client timing
// ---------------------------------------------------------------------------

/** Backend sends an SSE heartbeat comment every 25 seconds. */
export const SSE_SERVER_HEARTBEAT_MS = 25_000;

/** Number of times the SSE client reconnects before falling back to polling. */
export const SSE_MAX_RECONNECT_ATTEMPTS = 5;

/** Initial back-off before the first reconnect attempt (ms). */
export const SSE_RECONNECT_BACKOFF_BASE_MS = 1_000;

/** Maximum back-off between reconnect attempts (ms). */
export const SSE_RECONNECT_BACKOFF_MAX_MS = 60_000;

/** Timeout for SSE connection read (ms); should exceed server heartbeat. */
export const SSE_READ_TIMEOUT_MS = 60_000;
