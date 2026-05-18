/**
 * Replay analytics: aggregate mint_execution_events into summaries and reports.
 */

// ─── Single-intent replay summary ────────────────────────────────────────────

/**
 * Summarize one intent's replay events into a compact analytics object.
 *
 * @param {object[]} events  — rows from mint_execution_events, ordered by created_at asc
 * @returns {ReplaySummary}
 */
export function summarizeReplay(events) {
  if (!events?.length) {
    return {
      total_events: 0,
      phases: [],
      outcome: null,
      latency_ms: null,
      retries: 0,
      gas_escalations: 0,
      rpc_failovers: 0,
      error: null,
      first_event_at: null,
      last_event_at: null,
    }
  }

  const phases         = [...new Set(events.map(e => e.state))]
  const retries        = events.filter(e => e.state === 'retry').length
  const gasEscalations = events.filter(e => e.state === 'gas_escalation').length
  const rpcFailovers   = events.filter(e => e.state === 'rpc_failover').length

  const first = events[0]
  const last  = events[events.length - 1]

  // Prefer elapsed_ms from metadata for sub-millisecond accuracy
  const latencyMs = (last?.metadata?.elapsed_ms != null)
    ? Number(last.metadata.elapsed_ms)
    : null

  const errorEvent   = events.find(e =>
    e.state === 'error' || e.state === 'failed' || e.state === 'simulated_failure' || e.state === 'sim_error',
  )
  const successEvent = events.find(e =>
    e.state === 'success' || e.state === 'simulated_success',
  )

  const outcome = successEvent
    ? 'success'
    : errorEvent
      ? 'failed'
      : (last?.state ?? 'unknown')

  return {
    total_events:   events.length,
    phases,
    outcome,
    latency_ms:     latencyMs,
    retries,
    gas_escalations: gasEscalations,
    rpc_failovers:  rpcFailovers,
    error:          errorEvent?.message ?? null,
    first_event_at: first?.created_at ?? null,
    last_event_at:  last?.created_at  ?? null,
  }
}

// ─── Multi-intent aggregation ─────────────────────────────────────────────────

/**
 * Aggregate an array of replay summaries into a session-level analytics report.
 *
 * @param {ReturnType<typeof summarizeReplay>[]} summaries
 * @returns {SessionAnalytics}
 */
export function aggregateReplayAnalytics(summaries) {
  if (!summaries?.length) return { count: 0 }

  const outcomes = {}
  let totalLatency     = 0
  let latencyCount     = 0
  let totalRetries     = 0
  let totalEscalations = 0
  let totalFailovers   = 0

  for (const s of summaries) {
    const o = s.outcome ?? 'unknown'
    outcomes[o] = (outcomes[o] ?? 0) + 1

    if (s.latency_ms !== null && s.latency_ms !== undefined) {
      totalLatency += s.latency_ms
      latencyCount++
    }
    totalRetries     += s.retries          ?? 0
    totalEscalations += s.gas_escalations  ?? 0
    totalFailovers   += s.rpc_failovers    ?? 0
  }

  const n         = summaries.length
  const successes = outcomes.success ?? 0

  return {
    count:                     n,
    outcome_breakdown:         outcomes,
    success_rate_pct:          Math.round((successes / n) * 100),
    avg_latency_ms:            latencyCount > 0 ? Math.round(totalLatency / latencyCount) : null,
    total_retries:             totalRetries,
    total_gas_escalations:     totalEscalations,
    total_rpc_failovers:       totalFailovers,
    avg_retries_per_execution: Number((totalRetries / n).toFixed(2)),
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Load and summarize the most recent simulation/execution replays for a user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {number} [limit=20]
 * @returns {Promise<ReturnType<typeof summarizeReplay>[]>}
 */
export async function loadRecentReplays(supabase, userId, limit = 20) {
  const { data: intents, error } = await supabase
    .from('mint_intents')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['simulated_success', 'simulated_failure', 'success', 'failed'])
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error || !intents?.length) return []

  const ids = intents.map(i => i.id)
  const { data: events } = await supabase
    .from('mint_execution_events')
    .select('intent_id, state, message, metadata, created_at')
    .in('intent_id', ids)
    .order('created_at', { ascending: true })

  if (!events?.length) return []

  const byIntent = {}
  for (const e of events) {
    if (!byIntent[e.intent_id]) byIntent[e.intent_id] = []
    byIntent[e.intent_id].push(e)
  }

  return ids
    .filter(id => byIntent[id])
    .map(id => ({ intent_id: id, ...summarizeReplay(byIntent[id]) }))
}

/**
 * Fetch and return a full analytics report for a user's recent activity.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {number} [limit=20]
 * @returns {Promise<ReturnType<typeof aggregateReplayAnalytics> & { replays: object[] }>}
 */
export async function getUserAnalytics(supabase, userId, limit = 20) {
  const replays = await loadRecentReplays(supabase, userId, limit)
  const aggregate = aggregateReplayAnalytics(replays)
  return { ...aggregate, replays }
}
