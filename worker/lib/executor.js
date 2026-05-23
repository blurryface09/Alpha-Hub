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
import {
  confirmationTimeoutMs,
  loadExecutionProfile,
  optimizationTelemetry,
  recordExecutionOptimization,
} from '../../api/_lib/execution-optimizer.js'
import {
  classifyTxError,
  recordTxState,
  syncNonceAfterFailure,
  waitForReceiptWithRecovery,
} from './tx-resilience.js'

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
  let intent = null
  let chainKey = normaliseChain(queuedIntent.chain)
  let executionProfile = null
  let rpcLabel = null
  let gasParams = null
  let wallet = null
  let txHash = null
  let currentNonce = null

  // ── Step 1: Atomic claim ──────────────────────────────────────────────────
  log.info('claim', 'Attempting to claim intent')
  intent = await claimIntent(supabase, queuedIntent.id)
  if (!intent) {
    log.warn('claim', 'Intent already claimed by another worker — skipping')
    return
  }

  chainKey = normaliseChain(intent.chain)
  const rpcUrls = getRpcUrls(chainKey)
  executionProfile = await loadExecutionProfile(supabase, {
    chain: chainKey,
    contractAddress: intent.contract_address || intent.mint_contract_address || intent.to,
  })
  rpcLabel = executionProfile?.best_rpc || (rpcUrls[0] ? `${chainKey}_rpc` : null)
  const transport = createViemTransport(chainKey)
  const publicClient = createPublicClient({
    chain: buildChainDescriptor(chainKey),
    transport,
  })

  try {
    await insertEvent(supabase, intent, 'preparing', 'Strike worker: preparing execution')
    if (executionProfile?.success_count) {
      await insertEvent(supabase, intent, 'optimized', 'Execution profile loaded for this contract.', {
        ...optimizationTelemetry(executionProfile, {
          chain: chainKey,
          contractAddress: intent.contract_address || intent.mint_contract_address || intent.to,
          bestRpc: rpcLabel,
        }),
      }).catch(() => null)
    }

    // ── Step 2: Timing check (before loading wallet/gas to avoid wasted RPC calls) ──
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

      // Prewarm logging
      if (flagEnabled('PREWARM_ENABLED') && isInPrewarmWindow(executeAt, nowMs)) {
        const prewarmed = !!intent.call_data
        log.info('prewarm', 'Intent is in prewarm window', {
          ms_until_execute: remaining,
          prewarmed,
        })
        await insertEvent(supabase, intent, 'prewarm', prewarmed ? 'Call data precomputed — executor will skip detection at T=0.' : 'Approaching execution window.', {
          ms_until_execute: remaining,
          prewarmed,
        })
      }

      // Requeue — transition back to armed so next tick picks it up
      await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING, INTENT_STATES.ARMED, {
        last_state: `Waiting for execute time (${remaining}ms)`,
      })
      return
    }

    // ── Step 3: Load wallet ─────────────────────────────────────────────────
    log.info('prepare', 'Loading execution wallet')
    wallet = await loadExecutionWallet(supabase, intent, FLAGS, transport)

    // ── Step 4: Estimate gas ────────────────────────────────────────────────
    const gasStrategy = intent.gas_strategy || 'balanced'
    log.info('gas', 'Estimating gas', { strategy: gasStrategy })
    gasParams = await estimateGas(publicClient, gasStrategy, 0)

    // ── Step 5: Live execution gate ─────────────────────────────────────────
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
    const to = intent.mint_contract_address || intent.to || intent.contract_address
    if (!to) throw new Error('Intent has no contract address (mint_contract_address / to / contract_address)')

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
    let previousPendingTxHash = null

    txHash = await withRetry(
      async (attempt) => {
        // Escalate gas on retries
        if (attempt > 0 && flagEnabled('GAS_ESCALATION_ENABLED')) {
          currentGasParams = escalateGas(currentGasParams, attempt)
          await recordTxState(supabase, intent, 'accelerating', {
            txHash: pendingTxHash,
            chain: chainKey,
            nonce: currentNonce,
            reason: 'retry_gas_bump',
            gasStrategy: currentGasParams.strategy,
            message: 'Bumping gas for retry.',
          })
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
        currentNonce = nonce

        const hash = await wallet.walletClient.sendTransaction({
          ...baseTx,
          ...currentGasFields,
          nonce,
        })

        previousPendingTxHash = pendingTxHash
        pendingTxHash = hash
        if (attempt > 0 || previousPendingTxHash) {
          await recordTxState(supabase, intent, previousPendingTxHash && previousPendingTxHash !== hash ? 'replaced' : 'accelerated', {
            txHash: hash,
            previousTxHash: previousPendingTxHash,
            chain: chainKey,
            nonce,
            gasStrategy: currentGasParams.strategy,
            reason: 'replacement_submission',
            message: previousPendingTxHash && previousPendingTxHash !== hash
              ? 'Replacement transaction submitted.'
              : 'Accelerated transaction submitted.',
          })
        }
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
          const txReason = classifyTxError(err)
          await recordAttempt(supabase, intent, 'failed', {
            error_message: errMsg,
            tx_hash: pendingTxHash,
          }).catch(() => null)
          await recordTxState(supabase, intent, txReason === 'nonce_sync' ? 'recovering' : 'accelerating', {
            txHash: pendingTxHash,
            chain: chainKey,
            nonce: currentNonce,
            reason: txReason,
            error: errMsg,
            message: txReason === 'nonce_sync'
              ? 'Recovering nonce before retry.'
              : 'Preparing retry with adjusted transaction settings.',
          })
          if (txReason === 'nonce_sync') {
            await syncNonceAfterFailure(publicClient, wallet.address, nonceTracker, intent, supabase)
          }
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
    await recordTxState(supabase, intent, 'pending', {
      txHash,
      chain: chainKey,
      nonce: currentNonce,
      latencyMs,
      gasStrategy: currentGasParams.strategy,
      message: 'Transaction submitted and waiting for confirmation.',
    })
    await recordExecutionOptimization(supabase, {
      intent,
      chain: chainKey,
      contractAddress: intent.contract_address || intent.mint_contract_address || intent.to,
      status: 'submitted',
      latencyMs,
      gasUsed: baseTx.gas?.toString?.(),
      functionName: intent.function_name || intent.mint_function || null,
      functionSource: intent.function_source || 'strike_engine',
      rpcLabel,
    })
    await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING, INTENT_STATES.PENDING, {
      tx_hash: txHash,
      strike_enabled: false,
      last_state: 'Transaction pending on-chain',
    })
    await insertEvent(supabase, intent, 'pending', 'Strike transaction submitted and pending confirmation.', {
      tx_hash: txHash,
      latency_ms: latencyMs,
      nonce: currentNonce,
    })
    log.info('success', 'Intent executed successfully', {
      tx_hash: txHash,
      latency_ms: latencyMs,
      chain: chainKey,
    })

    const recovery = await waitForReceiptWithRecovery({
      supabase,
      intent,
      publicClient,
      txHash,
      chain: chainKey,
      nonce: currentNonce,
      walletAddress: wallet.address,
      nonceTracker,
      timeoutMs: confirmationTimeoutMs(executionProfile),
    })

    if (recovery.status === 'confirmed') {
      const receipt = recovery.receipt
      const confirmationMs = recovery.latencyMs
      await recordAttempt(supabase, intent, 'confirmed', {
        tx_hash: txHash,
        gas_used: receipt?.gasUsed?.toString?.(),
        confirmation_ms: confirmationMs,
        rpc_label: rpcLabel,
      }).catch(() => null)
      await insertEvent(supabase, intent, 'confirmed', 'Strike transaction confirmed.', {
        tx_hash: txHash,
        confirmation_ms: confirmationMs,
      }).catch(() => null)
      await recordExecutionOptimization(supabase, {
        intent,
        chain: chainKey,
        contractAddress: intent.contract_address || intent.mint_contract_address || intent.to,
        status: 'confirmed',
        latencyMs,
        confirmationMs,
        gasUsed: receipt?.gasUsed?.toString?.(),
        functionName: intent.function_name || intent.mint_function || null,
        functionSource: intent.function_source || 'strike_engine',
        rpcLabel,
      })
      await transitionIntent(supabase, intent.id, INTENT_STATES.PENDING, INTENT_STATES.SUCCESS, {
        tx_hash: txHash,
        strike_enabled: false,
        last_state: 'Strike transaction confirmed',
      }).catch(() => null)
    } else if (recovery.status === 'reverted' || recovery.status === 'dropped') {
      await transitionIntent(supabase, intent.id, INTENT_STATES.PENDING, INTENT_STATES.FAILED, {
        tx_hash: txHash,
        strike_enabled: false,
        last_state: recovery.status === 'dropped' ? 'Transaction dropped from mempool' : 'Transaction reverted on-chain',
      }).catch(() => null)
    }

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

    await recordExecutionOptimization(supabase, {
      intent,
      chain: chainKey,
      contractAddress: intent?.contract_address || intent?.mint_contract_address || intent?.to,
      status: 'failed',
      latencyMs,
      gasUsed: gasParams?.gas?.toString?.(),
      rpcLabel,
      errorMessage: message,
    })
    await recordTxState(supabase, intent, classifyTxError(err) === 'dropped' ? 'dropped' : 'recovering', {
      txHash,
      chain: chainKey,
      nonce: currentNonce,
      error: message,
      reason: classifyTxError(err),
      message: 'Transaction recovery recorded after execution failure.',
    }).catch(() => null)
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
