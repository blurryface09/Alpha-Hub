/**
 * Execution profiler and session telemetry accumulator.
 * Tracks per-execution metrics without blocking the execution path.
 * Session-level aggregation feeds the worker heartbeat telemetry.
 */

// ─── Per-execution profiler ───────────────────────────────────────────────────

/**
 * Create a profiler bound to one intent execution.
 *
 * @param {string|null} intentId
 * @param {string|null} userId
 */
export function createProfiler(intentId = null, userId = null) {
  const startMs = Date.now()
  let phaseStart = startMs

  const m = {
    intent_id:          intentId,
    user_id:            userId,
    started_at:         new Date(startMs).toISOString(),
    phases:             [],
    gas_estimates:      [],
    rpc_calls:          0,
    retries:            0,
    gas_escalations:    0,
    outcome:            null,
    latency_ms:         null,
    gas_strategy_final: null,
    rpc_provider_used:  null,
    mint_pattern:       null,
    exec_strategy:      null,
    preflight_score:    null,
    preflight_level:    null,
  }

  return {
    /** Mark entry into a named phase. Records duration since last phase call. */
    phase(name) {
      const now = Date.now()
      m.phases.push({ name, offset_ms: now - startMs, duration_ms: now - phaseStart })
      phaseStart = now
    },

    /** Record a gas estimation. */
    gasEstimate(strategy, baseFeeGwei, maxFeeGwei) {
      m.gas_estimates.push({
        strategy,
        base_fee_gwei:  baseFeeGwei ?? null,
        max_fee_gwei:   maxFeeGwei ?? null,
      })
      m.gas_strategy_final = strategy
    },

    /** Record an RPC call with the provider URL used. */
    rpcCall(url) {
      m.rpc_calls++
      if (url) m.rpc_provider_used = url
    },

    /** Increment retry counter. */
    retry(errorType) {
      m.retries++
      void errorType // captured for future breakdown
    },

    /** Increment gas escalation counter. */
    gasEscalation() {
      m.gas_escalations++
    },

    /** Record preflight check result. */
    preflight(score, level) {
      m.preflight_score = score
      m.preflight_level = level
    },

    /** Record pattern classification and chosen execution strategy. */
    pattern(mintPattern, execStrategy) {
      m.mint_pattern = mintPattern
      m.exec_strategy = execStrategy
    },

    /**
     * Finalize and return the completed metrics object.
     * @param {string} outcome  — simulation outcome
     * @param {string|null} [rpcUrl]
     */
    finish(outcome, rpcUrl = null) {
      m.outcome = outcome
      m.latency_ms = Date.now() - startMs
      if (rpcUrl) m.rpc_provider_used = rpcUrl
      return { ...m }
    },

    /** Return a point-in-time snapshot (non-destructive). */
    snapshot() {
      return { ...m, latency_ms: Date.now() - startMs }
    },

    /**
     * Persist the profile metrics as a single execution event row.
     * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
     */
    async persist(supabase) {
      if (!supabase || !intentId) return
      const snap = this.snapshot()
      try {
        await supabase.from('mint_execution_events').insert({
          intent_id: intentId,
          user_id:   userId,
          state:     'execution_profile',
          message:   `Profile: ${snap.outcome ?? 'running'} | ${snap.latency_ms}ms | ${snap.retries}r | ${snap.gas_escalations}e | pattern:${snap.mint_pattern ?? '?'}`,
          metadata:  snap,
        })
      } catch {}
    },
  }
}

// ─── Session-level telemetry accumulator ──────────────────────────────────────

const _session = []
const SESSION_CAP = 500

/**
 * Add a completed execution profile to the session rolling window.
 * @param {object} profile  — result of profiler.finish()
 */
export function recordProfile(profile) {
  _session.push({ ...profile, recorded_at: new Date().toISOString() })
  if (_session.length > SESSION_CAP) _session.shift()
}

/**
 * Return aggregated telemetry for the current worker session.
 * Emitted on each heartbeat log.
 *
 * @returns {object}
 */
export function getSessionTelemetry() {
  if (!_session.length) return { session_executions: 0 }

  const outcomes  = {}
  const patterns  = {}
  const strategies = {}
  let totalLatency  = 0
  let totalRetries  = 0
  let totalEscalations = 0

  for (const m of _session) {
    const o = m.outcome ?? 'unknown'
    outcomes[o]  = (outcomes[o]  ?? 0) + 1
    if (m.mint_pattern) patterns[m.mint_pattern]   = (patterns[m.mint_pattern]   ?? 0) + 1
    if (m.exec_strategy) strategies[m.exec_strategy] = (strategies[m.exec_strategy] ?? 0) + 1
    totalLatency     += m.latency_ms      ?? 0
    totalRetries     += m.retries          ?? 0
    totalEscalations += m.gas_escalations ?? 0
  }

  const n = _session.length
  const successes = outcomes.success ?? 0

  return {
    session_executions:      n,
    outcomes,
    patterns,
    strategies,
    avg_latency_ms:          Math.round(totalLatency / n),
    total_retries:           totalRetries,
    total_gas_escalations:   totalEscalations,
    success_rate_pct:        Math.round((successes / n) * 100),
  }
}
