/**
 * Execution replay and timeline logger.
 * Records all phase transitions, retries, RPC failovers, and gas escalations
 * for a single intent execution — for debugging, replay, and audit.
 */

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a replay log for one intent execution.
 *
 * @param {string|null} intentId
 * @param {string|null} userId
 * @returns {ReplayLog}
 */
export function createReplayLog(intentId = null, userId = null) {
  const startMs = Date.now()
  const events = []

  const replayLog = {
    /**
     * Record a phase event.
     * @param {string} phase
     * @param {string} message
     * @param {Record<string,unknown>} [data]
     */
    record(phase, message, data = {}) {
      const entry = {
        ts: new Date().toISOString(),
        elapsed_ms: Date.now() - startMs,
        phase,
        message,
      }
      if (Object.keys(data).length) entry.data = data
      events.push(entry)
    },

    /** Return a copy of all recorded events. */
    events() {
      return [...events]
    },

    /** Return events annotated with intent/user context. */
    toTimeline() {
      return events.map(e => ({
        intent_id: intentId,
        user_id: userId,
        ...e,
      }))
    },

    /** Human-readable box-drawn timeline for console output. */
    format() {
      const lines = [
        `╔══ Intent Replay ══════════════════════════════════════`,
        `║  intent : ${intentId ?? '(none)'}`,
        `║  user   : ${userId ?? '(none)'}`,
        `║  start  : ${new Date(startMs).toISOString()}`,
        `╠══ Timeline ════════════════════════════════════════════`,
      ]
      for (const e of events) {
        const ms = String(e.elapsed_ms).padStart(6)
        const ph = String(e.phase).padEnd(14)
        lines.push(`║  [${ms}ms] ${ph} ${e.message}`)
        if (e.data) {
          for (const [k, v] of Object.entries(e.data)) {
            const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v)
            lines.push(`║               ↳ ${k}: ${vStr}`)
          }
        }
      }
      const totalMs = events.length ? events[events.length - 1].elapsed_ms : 0
      lines.push(`╠══ Total: ${totalMs}ms ══════════════════════════════════════`)
      lines.push(`╚═══════════════════════════════════════════════════════`)
      return lines.join('\n')
    },

    /** Compact summary of what happened. */
    summary() {
      const phases = [...new Set(events.map(e => e.phase))]
      const retries = events.filter(e => e.phase === 'retry').length
      const rpcFailovers = events.filter(e => e.phase === 'rpc_failover').length
      const gasEscalations = events.filter(e => e.phase === 'gas_escalation').length
      const totalMs = events.length ? events[events.length - 1].elapsed_ms : 0
      const lastPhase = events[events.length - 1]?.phase ?? null

      return {
        intent_id: intentId,
        user_id: userId,
        phases_visited: phases,
        total_events: events.length,
        retries,
        rpc_failovers: rpcFailovers,
        gas_escalations: gasEscalations,
        total_ms: totalMs,
        outcome: lastPhase,
      }
    },

    /**
     * Persist all events to mint_execution_events.
     * Silently no-ops if supabase is null.
     * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
     */
    async saveToDb(supabase) {
      if (!supabase || !intentId) return
      const rows = events.map(e => ({
        intent_id: intentId,
        user_id: userId,
        state: e.phase,
        message: e.message,
        metadata: e.data ?? {},
      }))
      if (rows.length) {
        await supabase.from('mint_execution_events').insert(rows).throwOnError()
      }
    },
  }

  return replayLog
}
