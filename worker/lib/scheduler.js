/**
 * Precision execution scheduler.
 *
 * During the prewarm window (30s before execute_at) we register a setTimeout
 * for each intent so it fires at the EXACT execute_at millisecond — no polling
 * lag, no block-timing uncertainty. This is the critical path for FCFS mints.
 *
 * The polling loop remains as a safety net for:
 *   - Intents that arrive inside the prewarm window (already past register time)
 *   - Worker restarts (timers are lost, polling catches up within one loop tick)
 *   - Intents without execute_at (fire immediately on next tick)
 */

import { log as globalLog } from './logger.js'

// intentId → { handle: TimeoutHandle, executeAt: number, registeredAt: number }
const scheduled = new Map()

/**
 * Schedule an intent to fire at its execute_at timestamp.
 *
 * If execute_at is already past, calls executeIntentFn immediately (sync trigger,
 * async execution). If the intent is already registered, this is a no-op.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} intent - intent row with id and strike_execute_at
 * @param {Function} executeIntentFn - async fn(supabase, intent) => void
 */
export function scheduleIntent(supabase, intent, executeIntentFn) {
  if (!intent?.id || !executeIntentFn) return
  if (scheduled.has(intent.id)) return // already scheduled — idempotent

  const executeAtMs = intent.strike_execute_at
    ? new Date(intent.strike_execute_at).getTime()
    : null

  // No scheduled time → fire immediately on the next event-loop tick
  if (executeAtMs === null || Number.isNaN(executeAtMs)) {
    globalLog.info('scheduler', 'Intent has no execute_at — firing immediately', { intent_id: intent.id })
    setImmediate(() => {
      executeIntentFn(supabase, intent).catch(err =>
        globalLog.error('scheduler', 'Immediate execution error', {
          intent_id: intent.id,
          error: String(err?.message || err),
        }),
      )
    })
    return
  }

  const msUntil = executeAtMs - Date.now()

  if (msUntil <= 0) {
    // Already past execute_at — fire now (this happens when the worker starts
    // inside the prewarm window or catches up after a restart)
    globalLog.info('scheduler', 'Intent is past execute_at — firing now', {
      intent_id: intent.id,
      overdue_ms: -msUntil,
    })
    setImmediate(() => {
      executeIntentFn(supabase, intent).catch(err =>
        globalLog.error('scheduler', 'Overdue execution error', {
          intent_id: intent.id,
          error: String(err?.message || err),
        }),
      )
    })
    return
  }

  globalLog.info('scheduler', 'Precision timer registered', {
    intent_id:    intent.id,
    execute_at:   intent.strike_execute_at,
    fires_in_ms:  msUntil,
  })

  const handle = setTimeout(async () => {
    scheduled.delete(intent.id)
    globalLog.info('scheduler', 'Precision timer fired', {
      intent_id:  intent.id,
      drift_ms:   Date.now() - executeAtMs,
    })
    try {
      await executeIntentFn(supabase, intent)
    } catch (err) {
      globalLog.error('scheduler', 'Precision execution error', {
        intent_id: intent.id,
        error: String(err?.message || err),
      })
    }
  }, msUntil)

  scheduled.set(intent.id, { handle, executeAt: executeAtMs, registeredAt: Date.now() })
}

/**
 * Cancel a scheduled intent (e.g. if intent is cancelled or already executed).
 * @param {string} intentId
 */
export function cancelScheduled(intentId) {
  const entry = scheduled.get(intentId)
  if (entry) {
    clearTimeout(entry.handle)
    scheduled.delete(intentId)
    globalLog.info('scheduler', 'Precision timer cancelled', { intent_id: intentId })
  }
}

/**
 * Returns the count of currently scheduled intents.
 * @returns {number}
 */
export function scheduledCount() {
  return scheduled.size
}

/**
 * Returns a snapshot of all scheduled intents for heartbeat telemetry.
 * @returns {Array<{ intentId: string, executeAt: number, msUntil: number }>}
 */
export function getScheduled() {
  const now = Date.now()
  return [...scheduled.entries()].map(([id, entry]) => ({
    intentId:  id,
    executeAt: entry.executeAt,
    msUntil:   entry.executeAt - now,
  }))
}
