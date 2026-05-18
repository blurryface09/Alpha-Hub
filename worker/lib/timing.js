/**
 * Execution timing utilities.
 * All functions operate on numeric millisecond timestamps for precision.
 */

// ─── Constants (env-overridable) ──────────────────────────────────────────────

/** How many ms before mint_execute_at to enter the prewarm phase */
export const PREWARM_WINDOW_MS = Number(
  process.env.PREWARM_WINDOW_MS ?? 30_000,
)

/** Offset from mint_execute_at before firing the transaction (negative = fire early) */
export const EXECUTION_OFFSET_MS = Number(
  process.env.EXECUTION_OFFSET_MS ?? 0,
)

/** How long after mint_execute_at before marking an un-executed intent as expired */
export const INTENT_EXPIRY_AFTER_MS = Number(
  process.env.INTENT_EXPIRY_AFTER_MS ?? 300_000,
)

/** Maximum tolerated clock drift between worker and DB timestamps */
export const MAX_CLOCK_DRIFT_MS = Number(
  process.env.MAX_CLOCK_DRIFT_MS ?? 2_000,
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse executeAt to milliseconds, handling Date objects and ISO strings.
 * @param {Date|string|number} executeAt
 * @returns {number}
 */
function toMs(executeAt) {
  if (typeof executeAt === 'number') return executeAt
  if (executeAt instanceof Date) return executeAt.getTime()
  return new Date(executeAt).getTime()
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * True if we're within the prewarm window (the 30s before execute_at).
 * @param {Date|string|number} executeAt
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isInPrewarmWindow(executeAt, nowMs) {
  const execMs = toMs(executeAt)
  if (Number.isNaN(execMs)) return false
  const msUntil = execMs - nowMs
  return msUntil >= 0 && msUntil <= PREWARM_WINDOW_MS
}

/**
 * True if it is time (or past time) to fire the transaction.
 * @param {Date|string|number} executeAt
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isReadyToExecute(executeAt, nowMs) {
  const execMs = toMs(executeAt)
  if (Number.isNaN(execMs)) return true // No scheduled time → execute immediately
  return nowMs + EXECUTION_OFFSET_MS >= execMs
}

/**
 * True if the intent is past its expiry window without having been executed.
 * @param {Date|string|number} executeAt
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isExpired(executeAt, nowMs) {
  const execMs = toMs(executeAt)
  if (Number.isNaN(execMs)) return false
  return nowMs > execMs + INTENT_EXPIRY_AFTER_MS
}

/**
 * Milliseconds remaining until execution (negative if overdue).
 * Returns 0 if executeAt is not set.
 * @param {Date|string|number} executeAt
 * @param {number} nowMs
 * @returns {number}
 */
export function msUntilExecute(executeAt, nowMs) {
  const execMs = toMs(executeAt)
  if (Number.isNaN(execMs)) return 0
  return execMs - (nowMs + EXECUTION_OFFSET_MS)
}

/**
 * Milliseconds until the prewarm window opens.
 * Returns 0 or negative if already in the prewarm window or past execute_at.
 * @param {Date|string|number} executeAt
 * @param {number} nowMs
 * @returns {number}
 */
export function msUntilPrewarm(executeAt, nowMs) {
  const execMs = toMs(executeAt)
  if (Number.isNaN(execMs)) return 0
  // Prewarm starts at execMs - PREWARM_WINDOW_MS
  return (execMs - PREWARM_WINDOW_MS) - nowMs
}
