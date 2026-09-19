// Shared by the browser (heartbeat/sweep cadence) and the server (staleness
// cutoff), so the two can't drift apart.

/** How often a connected console stamps its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * A heartbeat older than this means the agent is no longer connected. Three
 * missed beats: tolerant of a reload or brief network blip, so a hiccup
 * doesn't churn conversation assignments.
 */
export const HEARTBEAT_STALE_MS = 15_000

/** How often each connected console asks the server to sweep for dropped agents. */
export const SWEEP_INTERVAL_MS = 10_000

/** After seeing a presence `leave`, wait this long before nudging the reaper. */
export const LEAVE_GRACE_MS = 3_000
