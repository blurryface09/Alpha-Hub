/**
 * Simulation executor for the Strike Engine.
 * Runs armed intents through simulateIntent() without touching the blockchain.
 * Persists the full replay timeline to mint_execution_events.
 * LIVE_EXECUTION_ENABLED must be false — enforced centrally in strike-engine.js.
 */

import { createMintAdapter, ADAPTER_MODES } from './mint-adapter.js'
import { simulateIntent, SIM_OUTCOMES } from './simulator.js'
import { createLogger } from './logger.js'
import {
  INTENT_STATES,
  claimForSimulation,
  transitionIntent,
  fetchSimFailedIntents,
  requeueForSimulation,
} from './queue.js'

// Max times a simulated_failure intent is auto-requeued before requiring manual retry
const MAX_AUTO_REQUEUES = 2

// ─── Core ──────────────────────────────────────────────────────────────────────

/**
 * Simulate a single armed intent through the full Strike execution path.
 * Claims the intent atomically, runs simulator.js, persists timeline, transitions state.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} queuedIntent  — intent row from DB (status: armed)
 * @returns {Promise<{intent, result, succeeded}|null>}  null if claim raced
 */
export async function simulateArmedIntent(supabase, queuedIntent) {
  const log = createLogger(queuedIntent.id, queuedIntent.user_id)

  // ── Atomic claim ────────────────────────────────────────────────────────────
  const intent = await claimForSimulation(supabase, queuedIntent.id)
  if (!intent) {
    log.warn('sim_claim', 'Intent already claimed for simulation — skipping', {
      intent_id: queuedIntent.id,
    })
    return null
  }

  log.info('sim_start', 'Simulation started', {
    intent_id: intent.id,
    contract: intent.contract_address || intent.mint_contract_address,
    chain: intent.chain ?? 'eth',
  })

  // Insert sim-start event
  await supabase.from('mint_execution_events').insert({
    intent_id: intent.id,
    user_id: intent.user_id,
    state: 'sim_start',
    message: 'Simulation execution started.',
    metadata: {
      adapter_mode: ADAPTER_MODES.SUCCESS,
      intent_id: intent.id,
    },
  }).throwOnError()

  // ── Run simulation ──────────────────────────────────────────────────────────
  const adapter = createMintAdapter({ mode: ADAPTER_MODES.SUCCESS })
  let result

  try {
    result = await simulateIntent(intent, {
      adapter,
      maxBackoffMs: 50,
    })
  } catch (err) {
    const errMsg = String(err?.message || err).slice(0, 240)
    log.error('sim_error', 'Uncaught simulation error', { error: errMsg, intent_id: intent.id })
    result = {
      outcome: SIM_OUTCOMES.SIMULATION_ERROR,
      error: errMsg,
      timeline: [],
      summary: { intent_id: intent.id },
      latency_ms: 0,
      tx_hash: null,
    }
  }

  const succeeded = result.outcome === SIM_OUTCOMES.SUCCESS
  const toState = succeeded ? INTENT_STATES.SIM_SUCCESS : INTENT_STATES.SIM_FAILED

  // ── Persist timeline events ─────────────────────────────────────────────────
  if (result.timeline?.length) {
    const rows = result.timeline.map(e => ({
      intent_id: intent.id,
      user_id: intent.user_id,
      state: e.phase,
      message: e.message,
      metadata: {
        ...(e.data ?? {}),
        elapsed_ms: e.elapsed_ms,
        ts: e.ts,
        sim: true,
      },
    }))
    await supabase.from('mint_execution_events').insert(rows).throwOnError()
  }

  // ── Transition to outcome state ─────────────────────────────────────────────
  await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING_SIM, toState, {
    simulation_status: succeeded ? 'passed' : 'failed',
    simulation_error: result.error ?? null,
    last_state: succeeded
      ? `Simulation passed (${result.latency_ms}ms)`
      : `Simulation failed: ${result.error ?? result.outcome}`,
  })

  // ── Summary event ───────────────────────────────────────────────────────────
  await supabase.from('mint_execution_events').insert({
    intent_id: intent.id,
    user_id: intent.user_id,
    state: toState,
    message: succeeded
      ? `Simulation passed. tx: ${result.tx_hash ?? 'sim-hash'}. Latency: ${result.latency_ms}ms.`
      : `Simulation failed. Outcome: ${result.outcome}. Error: ${result.error ?? 'unknown'}.`,
    metadata: result.summary ?? {},
  }).catch(() => null)

  log.info('sim_done', `Simulation ${succeeded ? 'passed' : 'failed'}`, {
    outcome: result.outcome,
    latency_ms: result.latency_ms,
    intent_id: intent.id,
  })

  return { intent, result, succeeded }
}

// ─── Auto-requeue sweep ────────────────────────────────────────────────────────

/**
 * Requeue recently failed simulations back to armed so the worker retries them.
 * Capped at MAX_AUTO_REQUEUES to avoid infinite loops on persistently broken intents.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} batchSize
 * @returns {Promise<number>}  count of intents requeued
 */
export async function runSimulationRequeueSweep(supabase, batchSize = 5) {
  const failed = await fetchSimFailedIntents(supabase, batchSize)
  let requeued = 0

  for (const intent of failed) {
    const count = intent.sim_requeue_count ?? 0
    if (count >= MAX_AUTO_REQUEUES) continue

    await requeueForSimulation(supabase, intent).catch(err => {
      const log = createLogger(intent.id, intent.user_id)
      log.error('sim_requeue', 'Failed to requeue simulation intent', {
        intent_id: intent.id,
        error: err.message,
      })
    })
    requeued++
  }

  return requeued
}
