/**
 * Structured JSON logger for the strike execution engine.
 * Every log entry is a JSON object written to stdout.
 */

/** Valid log levels */
const LEVELS = ['debug', 'info', 'warn', 'error']

/**
 * Valid execution phases.
 * @type {Set<string>}
 */
export const PHASES = new Set([
  'boot',
  'tick',
  'claim',
  'prepare',
  'prewarm',
  'gas',
  'simulate',
  'execute',
  'retry',
  'confirm',
  'success',
  'failed',
  'expired',
  'cancelled',
])

/**
 * Emit a single structured log line.
 * @param {string} level
 * @param {string} phase
 * @param {string} message
 * @param {string|null} intentId
 * @param {string|null} userId
 * @param {Record<string,unknown>} fields
 */
/** When LOG_SILENT=1 or NODE_ENV=test, suppress info/debug output. */
const SILENT = process.env.LOG_SILENT === '1' || process.env.NODE_ENV === 'test'

function emit(level, phase, message, intentId, userId, fields = {}) {
  if (SILENT && level !== 'error' && level !== 'warn') return

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    phase: PHASES.has(phase) ? phase : 'tick',
    ...(intentId ? { intent_id: intentId } : {}),
    ...(userId ? { user_id: userId } : {}),
    message,
    fields: Object.keys(fields).length ? fields : undefined,
  }
  // Remove undefined keys for clean JSON
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key]
  }
  const line = JSON.stringify(entry)
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

/**
 * Create a logger bound to an intent and user.
 * @param {string|null} intentId
 * @param {string|null} userId
 * @returns {{ info, warn, error, debug }}
 */
export function createLogger(intentId = null, userId = null) {
  return {
    /**
     * @param {string} phase
     * @param {string} message
     * @param {Record<string,unknown>} [fields]
     */
    info(phase, message, fields = {}) {
      emit('info', phase, message, intentId, userId, fields)
    },
    warn(phase, message, fields = {}) {
      emit('warn', phase, message, intentId, userId, fields)
    },
    error(phase, message, fields = {}) {
      emit('error', phase, message, intentId, userId, fields)
    },
    debug(phase, message, fields = {}) {
      emit('debug', phase, message, intentId, userId, fields)
    },
    /**
     * Return a new logger with updated context (non-mutating).
     * @param {{ intentId?: string, userId?: string }} ctx
     */
    child({ intentId: newIntentId, userId: newUserId } = {}) {
      return createLogger(
        newIntentId !== undefined ? newIntentId : intentId,
        newUserId !== undefined ? newUserId : userId,
      )
    },
  }
}

/** Global logger — no intent/user context. */
export const log = createLogger(null, null)
