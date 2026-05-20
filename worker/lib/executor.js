/**
 * Main execution unit for the Strike Engine.
 * Ties together: claim → wallet → gas → timing → execute → retry → confirm.
 */

import { createPublicClient } from 'viem'
import { FLAGS, flagEnabled } from './flags.js'
import { createLogger } from './logger.js'
import { createViemTransport, getRpcUrls } from './rpc.js'
import { estimateGas, escalateGas } from './gas.js'
import { isReadyToExecute, isInPrewarmWindow, msUntilExecute } from './timing.js'
import { loadExecutionWallet } from './wallet.js'
import { withRetry, classifyError, nonceTracker } from './retry.js'
import { claimIntent, transitionIntent, INTENT_STATES } from './queue.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString()
}

function normaliseChain(chain = 'eth') {
  const text = String(chain || '').toLowerCase()
  if (text.includes('base')) return 'base'
  if (text.includes('ape')) return 'apechain'
  if (text.includes('bnb') || text.includes('bsc')) return 'bnb'
  return 'eth'
}

const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  bnb: 56,
  apechain: 33139,
}

function buildChainDescriptor(chainKey) {
  return {
    id: CHAIN_IDS[chainKey] ?? 1,
    name: chainKey,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: getRpcUrls(chainKey) } },
  }
}

async function insertEvent(supabase, intent, state, message, metadata = {}) {
  await supabase
    .from('mint_execution_events')
    .insert({
      intent_id: intent.id,
      user_id: intent.user_id,
      state,
      message,
      metadata,
    })
    .throwOnError()
}

async function recordAttempt(supabase, intent, status, patch = {}) {
  await supabase
    .from('mint_attempts')
    .insert({
      intent_id: intent.id,
      mint_intent_id: intent.id,
      user_id: intent.user_id,
      status,
      ...patch,
    })
    .throwOnError()
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

/**
 * Log what would be executed without sending a real transaction.
 *
 * @param {object} intent
 * @param {object} gasParams
 * @param {object} wallet
 */
export async function dryRunIntent(intent, gasParams, wallet) {
  const log = createLogger(intent.id, intent.user_id)
  log.info('execute', '[DRY RUN] Would send transaction', {
    dry_run: true,
    to: intent.mint_contract_address || intent.to,
    value: intent.mint_price || intent.value || '0',
    chain: normaliseChain(intent.chain),
    wallet_address: wallet?.address,
    gas_strategy: gasParams?.strategy,
    max_fee_gwei: gasParams?.maxFeePerGas
      ? (Number(gasParams.maxFeePerGas) / 1e9).toFixed(4)
      : null,
    max_priority_fee_gwei: gasParams?.maxPriorityFeePerGas
      ? (Number(gasParams.maxPriorityFeePerGas) / 1e9).toFixed(4)
      : null,
    is_eip1559: gasParams?.isEip1559,
  })
}

// ─── Main execution ───────────────────────────────────────────────────────────

/**
 * Execute a single mint intent through the full lifecycle.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} queuedIntent  — intent row from DB (pre-claim)
 * @returns {Promise<void>}
 */
export async function executeIntent(supabase, queuedIntent) {
  const startMs = Date.now()
  const log = createLogger(queuedIntent.id, queuedIntent.user_id)

  // ── Step 1: Atomic claim ──────────────────────────────────────────────────
  log.info('claim', 'Attempting to claim intent')
  const intent = await claimIntent(supabase, queuedIntent.id)
  if (!intent) {
    log.warn('claim', 'Intent already claimed by another worker — skipping')
    return
  }

  const chainKey = normaliseChain(intent.chain)
  const transport = createViemTransport(chainKey)
  const publicClient = createPublicClient({
    chain: buildChainDescriptor(chainKey),
    transport,
  })

  let gasParams = null
  let wallet = null

  try {
    await insertEvent(supabase, intent, 'preparing', 'Strike worker: preparing execution')

    // ── Step 2: Load wallet ─────────────────────────────────────────────────
    log.info('prepare', 'Loading execution wallet')
    wallet = await loadExecutionWallet(supabase, intent, FLAGS, transport)

    // ── Step 3: Estimate gas ────────────────────────────────────────────────
    const gasStrategy = intent.gas_strategy || 'balanced'
    log.info('gas', 'Estimating gas', { strategy: gasStrategy })
    gasParams = await estimateGas(publicClient, gasStrategy, 0)

    // ── Step 4: Timing check ────────────────────────────────────────────────
    const nowMs = Date.now()
    const executeAt = intent.strike_execute_at
      ? new Date(intent.strike_execute_at).getTime()
      : null

    if (executeAt !== null && !isReadyToExecute(executeAt, nowMs)) {
      const remaining = msUntilExecute(executeAt, nowMs)
      log.info('prepare', 'Intent not ready to execute yet — requeueing', {
        ms_until_execute: remaining,
        execute_at: intent.strike_execute_at,
      })

      // Step 5: Prewarm logging
      if (flagEnabled('PREWARM_ENABLED') && isInPrewarmWindow(executeAt, nowMs)) {
        const prewarmed = !!intent.call_data
        log.info('prewarm', 'Intent is in prewarm window', {
          ms_until_execute: remaining,
          prewarmed,
          wallet_loaded: true,
          gas_prepared: true,
        })
        await insertEvent(supabase, intent, 'prewarm', prewarmed ? 'Call data precomputed — executor will skip detection at T=0.' : 'Wallet and gas prewarmed.', {
          ms_until_execute: remaining,
          prewarmed,
          gas_strategy: gasStrategy,
        })
      }

      // Requeue — transition back to armed so next tick picks it up
      await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING, INTENT_STATES.ARMED, {
        last_state: `Waiting for execute time (${remaining}ms)`,
      })
      return
    }

    // ── Step 6: Live execution gate ─────────────────────────────────────────
    if (!flagEnabled('LIVE_EXECUTION_ENABLED')) {
      if (flagEnabled('DRY_RUN_LOGGING')) {
        await dryRunIntent(intent, gasParams, wallet)
      }
      log.warn('execute', 'LIVE_EXECUTION_ENABLED=false — transaction not sent (dry run)')
      await insertEvent(supabase, intent, 'execute', 'Dry run: transaction would be sent.', {
        dry_run: true,
      })
      // Transition back to armed so the intent stays in queue for when live is enabled
      await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING, INTENT_STATES.ARMED, {
        last_state: 'Dry run — awaiting LIVE_EXECUTION_ENABLED',
      })
      return
    }

    // ── Step 7: Build transaction ───────────────────────────────────────────
    const to = intent.mint_contract_address || intent.to
    if (!to) throw new Error('Intent has no contract address (mint_contract_address / to)')

    const value = BigInt(intent.mint_price || intent.value || '0')
    const data = intent.call_data || intent.data || undefined
    const gas = intent.gas_limit ? BigInt(intent.gas_limit) : undefined

    const baseTx = {
      to,
      value,
      ...(data ? { data } : {}),
      ...(gas ? { gas } : {}),
    }

    const gasFields = gasParams.isEip1559
      ? { maxFeePerGas: gasParams.maxFeePerGas, maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas }
      : { gasPrice: gasParams.gasPrice }

    await insertEvent(supabase, intent, 'simulate', 'Broadcasting Strike transaction.', {
      chain: chainKey,
      strategy: gasParams.strategy,
      base_fee_gwei: gasParams.baseFeeGwei,
    })

    // ── Step 8: withRetry → sendTransaction ────────────────────────────────
    let currentGasParams = { ...gasParams }
    let pendingTxHash = null

    const txHash = await withRetry(
      async (attempt) => {
        // Escalate gas on retries
        if (attempt > 0 && flagEnabled('GAS_ESCALATION_ENABLED')) {
          currentGasParams = escalateGas(currentGasParams, attempt)
          log.info('retry', 'Gas escalated for retry', {
            attempt,
            max_fee_gwei: currentGasParams.maxFeePerGas
              ? (Number(currentGasParams.maxFeePerGas) / 1e9).toFixed(4)
              : null,
          })
        }

        const currentGasFields = currentGasParams.isEip1559
          ? {
              maxFeePerGas: currentGasParams.maxFeePerGas,
              maxPriorityFeePerGas: currentGasParams.maxPriorityFeePerGas,
            }
          : { gasPrice: currentGasParams.gasPrice }

        // Use tracked nonce if available
        const trackedNonce = nonceTracker.get(wallet.address)
        const nonce = trackedNonce !== undefined
          ? trackedNonce
          : await publicClient.getTransactionCount({ address: wallet.address, blockTag: 'pending' })

        nonceTracker.set(wallet.address, nonce)

        const hash = await wallet.walletClient.sendTransaction({
          ...baseTx,
          ...currentGasFields,
          nonce,
        })

        pendingTxHash = hash
        return hash
      },
      {
        intentId: intent.id,
        userId: intent.user_id,
        enabled: flagEnabled('RETRY_ENABLED'),
        address: wallet.address,
        publicClient,
        onRetry: async (attempt, err, classification) => {
          const errMsg = String(err?.shortMessage || err?.message || err).slice(0, 240)
          await recordAttempt(supabase, intent, 'failed', {
            error_message: errMsg,
            tx_hash: pendingTxHash,
          }).catch(() => null)
          await insertEvent(supabase, intent, 'retry', `Retry attempt ${attempt + 1}: ${classification.type}`, {
            attempt,
            error_type: classification.type,
            error: errMsg,
          }).catch(() => null)

          // Mark as retrying in DB
          await supabase.from('mint_intents').update({
            status: INTENT_STATES.RETRYING,
            last_state: `Retry ${attempt + 1}: ${classification.type}`,
            updated_at: now(),
          }).eq('id', intent.id).catch(() => null)
        },
      },
    )

    // ── Step 9: Success ─────────────────────────────────────────────────────
    const latencyMs = Date.now() - startMs
    await recordAttempt(supabase, intent, 'submitted', { tx_hash: txHash })
    await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING, INTENT_STATES.SUCCESS, {
      tx_hash: txHash,
      strike_enabled: false,
      last_state: 'Strike transaction submitted',
    })
    await insertEvent(supabase, intent, 'success', 'Strike transaction submitted.', {
      tx_hash: txHash,
      latency_ms: latencyMs,
    })
    log.info('success', 'Intent executed successfully', {
      tx_hash: txHash,
      latency_ms: latencyMs,
      chain: chainKey,
    })

  } catch (err) {
    // ── Step 10: Final failure ──────────────────────────────────────────────
    const message = String(err?.shortMessage || err?.message || 'Strike execution failed.').slice(0, 240)
    const classification = classifyError(err)
    const latencyMs = Date.now() - startMs

    log.error('failed', 'Intent execution failed', {
      error: message,
      error_type: classification.type,
      latency_ms: latencyMs,
    })

    await recordAttempt(supabase, intent, 'failed', { error_message: message }).catch(() => null)
    await supabase.from('mint_intents').update({
      status: INTENT_STATES.FAILED,
      strike_enabled: false,
      simulation_status: 'failed',
      simulation_error: message,
      last_state: 'Strike failed safely',
      updated_at: now(),
    }).eq('id', intent.id).catch(() => null)
    await insertEvent(
      supabase,
      intent,
      'failed',
      'Strike failed safely. No duplicate transaction will be sent.',
      { error: message, error_type: classification.type, latency_ms: latencyMs },
    ).catch(() => null)
  }
}
