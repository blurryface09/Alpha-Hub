/**
 * Simulation executor for the Strike Engine.
 * Runs armed intents through the full execution path using MintAdapter.
 * Integrates preflight risk checks, pattern classification, execution strategy
 * auto-selection, adaptive gas, and profiling telemetry.
 *
 * LIVE_EXECUTION_ENABLED must be false — enforced centrally in strike-engine.js.
 */

import { createMintAdapter, ADAPTER_MODES }       from './mint-adapter.js'
import { simulateIntent, SIM_OUTCOMES }            from './simulator.js'
import { createLogger }                            from './logger.js'
import { flagEnabled }                             from './flags.js'
import { preflightCheck }                          from './preflight.js'
import { classifyMintPattern, selectExecutionStrategy } from './pattern.js'
import { createProfiler, recordProfile }           from './profiler.js'
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
 * Claims atomically, runs preflight + pattern checks, runs simulator.js,
 * persists timeline + profile, transitions state.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} queuedIntent  — intent row from DB (status: armed)
 * @returns {Promise<{intent, result, succeeded, profile}|null>}  null if claim raced
 */
export async function simulateArmedIntent(supabase, queuedIntent) {
  const log      = createLogger(queuedIntent.id, queuedIntent.user_id)
  const profiler = createProfiler(queuedIntent.id, queuedIntent.user_id)

  // ── Preflight check ─────────────────────────────────────────────────────────
  if (flagEnabled('PREFLIGHT_ENABLED')) {
    profiler.phase('preflight')
    const pf = preflightCheck(queuedIntent)
    profiler.preflight(pf.risk_score, pf.risk_level)

    if (!pf.safe) {
      log.warn('preflight', 'Preflight blockers — skipping simulation', {
        intent_id: queuedIntent.id,
        blockers:  pf.blockers,
        risk_score: pf.risk_score,
        risk_level: pf.risk_level,
      })
      // Insert preflight-failed event without claiming
      try {
        await supabase.from('mint_execution_events').insert({
          intent_id: queuedIntent.id,
          user_id:   queuedIntent.user_id,
          state:     'preflight_failed',
          message:   `Preflight blocked: ${pf.blockers.join('; ')}`,
          metadata:  { risk_score: pf.risk_score, risk_level: pf.risk_level, blockers: pf.blockers },
        })
      } catch {}
      return null
    }

    if (pf.warnings.length) {
      log.warn('preflight', 'Preflight warnings', {
        intent_id: queuedIntent.id,
        warnings:  pf.warnings,
        risk_score: pf.risk_score,
      })
    }
  }

  // ── Pattern classification + strategy selection ─────────────────────────────
  let selectedStrategy = null
  let mintPattern      = null

  if (flagEnabled('PATTERN_CLASSIFICATION_ENABLED')) {
    profiler.phase('pattern')
    const classification = classifyMintPattern(queuedIntent)
    mintPattern = classification.pattern

    const networkContext = {}
    selectedStrategy = selectExecutionStrategy(mintPattern, networkContext)

    profiler.pattern(mintPattern, selectedStrategy.strategy)

    log.info('pattern', 'Mint pattern classified', {
      intent_id:  queuedIntent.id,
      pattern:    mintPattern,
      confidence: classification.confidence,
      strategy:   selectedStrategy.strategy,
      gas_strategy: selectedStrategy.gas_strategy,
      signals:    classification.signals,
    })
  }

  // ── Atomic claim ─────────────────────────────────────────────────────────────
  profiler.phase('claim')
  const intent = await claimForSimulation(supabase, queuedIntent.id)
  if (!intent) {
    log.warn('sim_claim', 'Intent already claimed for simulation — skipping', {
      intent_id: queuedIntent.id,
    })
    return null
  }

  log.info('sim_start', 'Simulation started', {
    intent_id:    intent.id,
    contract:     intent.contract_address || intent.mint_contract_address,
    chain:        intent.chain ?? 'eth',
    mint_pattern: mintPattern,
    gas_strategy: selectedStrategy?.gas_strategy ?? 'balanced',
  })

  // Insert sim-start event
  await supabase.from('mint_execution_events').insert({
    intent_id: intent.id,
    user_id:   intent.user_id,
    state:     'sim_start',
    message:   'Simulation execution started.',
    metadata:  {
      adapter_mode:  ADAPTER_MODES.SUCCESS,
      intent_id:     intent.id,
      mint_pattern:  mintPattern,
      gas_strategy:  selectedStrategy?.gas_strategy ?? 'balanced',
      exec_strategy: selectedStrategy?.strategy ?? 'default',
    },
  }).throwOnError()

  // ── Run simulation ───────────────────────────────────────────────────────────
  profiler.phase('simulate')
  const adapter = createMintAdapter({ mode: ADAPTER_MODES.SUCCESS })

  // Apply the auto-selected gas strategy to the intent
  const intentWithStrategy = selectedStrategy
    ? { ...intent, gas_strategy: selectedStrategy.gas_strategy }
    : intent

  let result

  try {
    result = await simulateIntent(intentWithStrategy, {
      adapter,
      maxBackoffMs: 50,
    })
  } catch (err) {
    const errMsg = String(err?.message || err).slice(0, 240)
    log.error('sim_error', 'Uncaught simulation error', { error: errMsg, intent_id: intent.id })
    result = {
      outcome:    SIM_OUTCOMES.SIMULATION_ERROR,
      error:      errMsg,
      timeline:   [],
      summary:    { intent_id: intent.id },
      latency_ms: 0,
      tx_hash:    null,
    }
  }

  // ── NOT_READY: timing gate not yet open — requeue rather than fail ──────────
  if (result.outcome === SIM_OUTCOMES.NOT_READY) {
    log.info('sim_not_ready', 'Timing gate not open — requeuing intent to armed', {
      intent_id:        intent.id,
      ms_until_execute: result.ms_until_execute,
    })
    try {
      await supabase.from('mint_execution_events').insert({
        intent_id: intent.id,
        user_id:   intent.user_id,
        state:     'sim_requeue',
        message:   `Simulation early — timing gate opens in ${result.ms_until_execute}ms. Requeued.`,
        metadata:  { ms_until_execute: result.ms_until_execute, in_prewarm: result.in_prewarm },
      })
    } catch {}
    await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING_SIM, INTENT_STATES.ARMED, {
      last_state: `Sim requeue — execute in ${result.ms_until_execute}ms`,
    })
    return null
  }

  const succeeded = result.outcome === SIM_OUTCOMES.SUCCESS
  const toState   = succeeded ? INTENT_STATES.SIM_SUCCESS : INTENT_STATES.SIM_FAILED

  // ── Persist timeline events ──────────────────────────────────────────────────
  profiler.phase('persist')
  if (result.timeline?.length) {
    const rows = result.timeline.map(e => ({
      intent_id: intent.id,
      user_id:   intent.user_id,
      state:     e.phase,
      message:   e.message,
      metadata:  {
        ...(e.data ?? {}),
        elapsed_ms: e.elapsed_ms,
        ts:         e.ts,
        sim:        true,
      },
    }))
    await supabase.from('mint_execution_events').insert(rows).throwOnError()
  }

  // ── Transition to outcome state ──────────────────────────────────────────────
  await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING_SIM, toState, {
    simulation_status: succeeded ? 'passed' : 'failed',
    simulation_error:  result.error ?? null,
    last_state:        succeeded
      ? `Simulation passed (${result.latency_ms}ms) — pattern:${mintPattern ?? '?'}`
      : `Simulation failed: ${result.error ?? result.outcome}`,
  })

  // ── Summary + profile events ─────────────────────────────────────────────────
  try {
    await supabase.from('mint_execution_events').insert({
      intent_id: intent.id,
      user_id:   intent.user_id,
      state:     toState,
      message:   succeeded
        ? `Simulation passed. tx: ${result.tx_hash ?? 'sim-hash'}. Latency: ${result.latency_ms}ms.`
        : `Simulation failed. Outcome: ${result.outcome}. Error: ${result.error ?? 'unknown'}.`,
      metadata:  result.summary ?? {},
    })
  } catch {}

  const profile = profiler.finish(result.outcome)
  recordProfile(profile)

  if (flagEnabled('EXECUTION_TELEMETRY_ENABLED')) {
    await profiler.persist(supabase)
  }

  log.info('sim_done', `Simulation ${succeeded ? 'passed' : 'failed'}`, {
    outcome:      result.outcome,
    latency_ms:   result.latency_ms,
    intent_id:    intent.id,
    mint_pattern: mintPattern,
    retries:      profile.retries,
  })

  return { intent, result, succeeded, profile }
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
        error:     err.message,
      })
    })
    requeued++
  }

  return requeued
}
