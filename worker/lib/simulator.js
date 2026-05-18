/**
 * Strike Engine simulation layer.
 * Runs the full execution path (gas → timing → tx → retry) using a MintAdapter
 * instead of real blockchain RPCs. Never broadcasts a transaction.
 */

import { estimateGas, escalateGas } from './gas.js'
import { isReadyToExecute, isInPrewarmWindow, msUntilExecute } from './timing.js'
import { classifyError, backoffMs, nonceTracker } from './retry.js'
import { createReplayLog } from './replay.js'
import { flagEnabled } from './flags.js'

// ─── Outcome constants ────────────────────────────────────────────────────────

export const SIM_OUTCOMES = {
  SUCCESS: 'success',
  NOT_READY: 'not_ready',
  WALLET_MISSING: 'wallet_missing',
  GAS_FAILED: 'gas_failed',
  REVERTED: 'reverted',
  RETRY_EXHAUSTED: 'retry_exhausted',
  SIMULATION_ERROR: 'simulation_error',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseStrategy(s) {
  return ['safe', 'balanced', 'aggressive'].includes(String(s))
    ? String(s)
    : 'balanced'
}

function buildResult(outcome, replay, startMs, txHash = null, error = null, extra = {}) {
  return {
    outcome,
    tx_hash: txHash,
    latency_ms: Date.now() - startMs,
    timeline: replay.toTimeline(),
    summary: replay.summary(),
    error: error
      ? String(error?.shortMessage || error?.message || error).slice(0, 240)
      : null,
    ...extra,
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Simulate a full Strike execution without sending a real transaction.
 *
 * @param {object} intent  — intent object (real or mock)
 * @param {object} options
 * @param {import('./mint-adapter.js').MintAdapter} options.adapter — required
 * @param {{ address: string }} [options.wallet]  — fake wallet; auto-generated if omitted
 * @param {boolean} [options.verbose=false]  — print timeline to stdout
 * @param {number} [options.maxRetries]  — override retry cap per error type
 * @param {number} [options.maxBackoffMs=100]  — cap backoff in simulation (default 100ms)
 * @returns {Promise<SimulationResult>}
 */
export async function simulateIntent(intent, options = {}) {
  const {
    adapter,
    wallet: injectedWallet,
    verbose = false,
    maxRetries,
    maxBackoffMs = 100,
  } = options

  if (!adapter) throw new Error('simulateIntent: options.adapter is required')

  const startMs = Date.now()
  const replay = createReplayLog(intent.id, intent.user_id)

  replay.record('start', 'Simulation started', {
    intent_id: intent.id,
    adapter_mode: adapter.mode,
  })

  // ── Phase 1: Wallet ───────────────────────────────────────────────────────
  const walletAddress = injectedWallet?.address
    ?? `0xsim${String(intent.id ?? 'test').replace(/[^a-z0-9]/gi, '').slice(0, 36).padEnd(36, '0')}`

  replay.record('wallet', 'Wallet resolved', { address: walletAddress })

  // ── Phase 2: Gas estimation ───────────────────────────────────────────────
  const gasStrategy = normaliseStrategy(intent.gas_strategy)
  let gasParams
  try {
    const publicClient = adapter.buildPublicClient()
    gasParams = await estimateGas(publicClient, gasStrategy, 0)
    replay.record('gas', 'Gas estimated', {
      strategy: gasStrategy,
      is_eip1559: gasParams.isEip1559,
      base_fee_gwei: gasParams.baseFeeGwei,
      max_fee_gwei: gasParams.maxFeePerGas
        ? (Number(gasParams.maxFeePerGas) / 1e9).toFixed(4)
        : null,
      priority_fee_gwei: gasParams.maxPriorityFeePerGas
        ? (Number(gasParams.maxPriorityFeePerGas) / 1e9).toFixed(4)
        : null,
    })
  } catch (err) {
    replay.record('gas_failed', 'Gas estimation failed', { error: err.message })
    const result = buildResult(SIM_OUTCOMES.GAS_FAILED, replay, startMs, null, err)
    if (verbose) _printResult(replay, result)
    return result
  }

  // ── Phase 3: Timing check ─────────────────────────────────────────────────
  const nowMs = Date.now()
  const executeAt = intent.strike_execute_at
    ? new Date(intent.strike_execute_at).getTime()
    : null

  if (executeAt !== null && !isReadyToExecute(executeAt, nowMs)) {
    const remaining = msUntilExecute(executeAt, nowMs)
    const inPrewarm = isInPrewarmWindow(executeAt, nowMs)
    replay.record('timing', 'Not ready to execute', {
      ms_until_execute: remaining,
      in_prewarm: inPrewarm,
      execute_at: intent.strike_execute_at,
    })
    const result = buildResult(SIM_OUTCOMES.NOT_READY, replay, startMs, null, null, {
      ms_until_execute: remaining,
      in_prewarm: inPrewarm,
    })
    if (verbose) _printResult(replay, result)
    return result
  }

  replay.record('timing', 'Timing check passed', {
    execute_at: intent.strike_execute_at ?? 'immediate',
  })

  // ── Phase 4: Build tx payload ─────────────────────────────────────────────
  const to = intent.mint_contract_address || intent.to
    || '0x0000000000000000000000000000000000000000'
  const value = BigInt(intent.mint_price || intent.value || '0')
  const data = intent.call_data || intent.data || undefined

  replay.record('prepare', 'Transaction payload built', {
    to,
    value_wei: value.toString(),
    has_calldata: Boolean(data),
    chain: intent.chain ?? 'eth',
  })

  // ── Phase 5: Execute with retry loop ─────────────────────────────────────
  let currentGasParams = { ...gasParams }
  let attempt = 0
  let txHash = null

  while (true) {
    // Escalate gas on retries
    if (attempt > 0 && flagEnabled('GAS_ESCALATION_ENABLED')) {
      currentGasParams = escalateGas(currentGasParams, attempt)
      replay.record('gas_escalation', `Gas escalated for retry ${attempt}`, {
        attempt,
        max_fee_gwei: currentGasParams.maxFeePerGas
          ? (Number(currentGasParams.maxFeePerGas) / 1e9).toFixed(4)
          : null,
        gas_price_gwei: currentGasParams.gasPrice
          ? (Number(currentGasParams.gasPrice) / 1e9).toFixed(4)
          : null,
      })
    }

    replay.record('execute', `Sending transaction (attempt ${attempt + 1})`, {
      attempt,
      strategy: currentGasParams.strategy,
      to,
      value_wei: value.toString(),
    })

    try {
      txHash = await adapter.sendTransaction({
        to,
        value,
        data,
        nonce: attempt,
        ...currentGasParams,
      })

      replay.record('success', 'Transaction sent successfully', {
        tx_hash: txHash,
        attempt,
        total_attempts: attempt + 1,
        latency_ms: Date.now() - startMs,
      })
      break

    } catch (err) {
      const classification = classifyError(err)

      replay.record('error', `Attempt ${attempt + 1} failed`, {
        error_type: classification.type,
        retryable: classification.retryable,
        error: String(err?.shortMessage || err?.message || err).slice(0, 120),
      })

      const cap = maxRetries !== undefined ? maxRetries : classification.maxRetries
      const retryEnabled = flagEnabled('RETRY_ENABLED')

      if (!classification.retryable || !retryEnabled || attempt >= cap) {
        const outcome = !classification.retryable
          ? SIM_OUTCOMES.REVERTED
          : SIM_OUTCOMES.RETRY_EXHAUSTED

        replay.record('failed', 'Execution failed', {
          outcome,
          total_attempts: attempt + 1,
          retry_enabled: retryEnabled,
        })

        const result = buildResult(outcome, replay, startMs, null, err)
        if (verbose) _printResult(replay, result)
        return result
      }

      const delay = Math.min(backoffMs(attempt, classification.type), maxBackoffMs)
      replay.record('retry', `Backing off ${Math.round(delay)}ms before retry`, {
        attempt,
        next_attempt: attempt + 1,
        delay_ms: Math.round(delay),
        error_type: classification.type,
      })

      // Refresh nonce on nonce_too_low
      if (classification.type === 'nonce_too_low') {
        const fresh = await adapter.getTransactionCount()
        nonceTracker.set(walletAddress, fresh)
        replay.record('nonce_refresh', 'Nonce refreshed from adapter', {
          address: walletAddress,
          nonce: fresh,
        })
      }

      await new Promise(r => setTimeout(r, delay))
      attempt++
    }
  }

  // ── Phase 6: Done ─────────────────────────────────────────────────────────
  const result = buildResult(SIM_OUTCOMES.SUCCESS, replay, startMs, txHash)
  if (verbose) _printResult(replay, result)
  return result
}

// ─── Print helper ─────────────────────────────────────────────────────────────

function _printResult(replay, result) {
  console.log(replay.format())
  console.log(
    `\nOutcome: ${result.outcome}  tx: ${result.tx_hash ?? 'none'}  latency: ${result.latency_ms}ms`,
  )
}

// ─── Batch simulation ─────────────────────────────────────────────────────────

/**
 * Simulate multiple intents in sequence, returning an array of results.
 *
 * @param {object[]} intents
 * @param {object} options  — same as simulateIntent, adapter is required
 * @returns {Promise<SimulationResult[]>}
 */
export async function simulateBatch(intents, options = {}) {
  const results = []
  for (const intent of intents) {
    const result = await simulateIntent(intent, options)
    results.push(result)
  }
  return results
}

/**
 * Run a single intent through all three gas strategies and return all results.
 * Useful for comparing gas cost across strategy tiers.
 *
 * @param {object} intent
 * @param {import('./mint-adapter.js').MintAdapter} adapter
 * @returns {Promise<Record<string,SimulationResult>>}
 */
export async function simulateAllStrategies(intent, adapter) {
  const strategies = ['safe', 'balanced', 'aggressive']
  const results = {}
  for (const strategy of strategies) {
    adapter.reset?.()
    results[strategy] = await simulateIntent(
      { ...intent, gas_strategy: strategy },
      { adapter },
    )
  }
  return results
}
