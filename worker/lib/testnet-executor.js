/**
 * Testnet execution harness for the Strike Engine.
 * Executes real viem transactions on Sepolia / Base Sepolia ONLY.
 * Every entry point hard-rejects mainnet chain IDs.
 *
 * State flow: simulated_success → executing_testnet → testnet_success | testnet_failed
 *
 * Requires: TESTNET_EXECUTION_ENABLED=true, LIVE_EXECUTION_ENABLED=false (enforced in strike-engine.js).
 */

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { createLogger }                                  from './logger.js'
import { FLAGS, flagEnabled }                            from './flags.js'
import { createProfiler, recordProfile }                 from './profiler.js'
import { estimateGas, adaptiveEscalateGas, getCongestionLevel } from './gas.js'
import { classifyError, nonceTracker }                   from './retry.js'
import { decryptPrivateKey }                             from './wallet.js'
import {
  assertTestnetOnly,
  assertNotMainnet,
  normalizeTestnetChain,
  getTestnetChain,
  getTestnetRpcUrls,
  getExplorerTxLink,
} from './testnet.js'
import {
  INTENT_STATES,
  claimForTestnet,
  transitionIntent,
  fetchTestnetReadyIntents,
} from './queue.js'
import {
  validateTransaction,
  enforceSpendCap,
  validateContractAllowlist,
  preventDuplicateTx,
  preBroadcastSimulate,
} from './security.js'
import { logSigningEvent } from './audit.js'

export { fetchTestnetReadyIntents }

// ─── Constants ────────────────────────────────────────────────────────────────

const RECEIPT_TIMEOUT_MS    = 120_000
const RECEIPT_CONFIRMATIONS = 1
const GAS_CAP_GWEI          = 200

// ─── Vault helpers ────────────────────────────────────────────────────────────

async function loadVaultForIntent(supabase, intent) {
  if (intent.vault_wallet_id) {
    const { data, error } = await supabase
      .from('alpha_vault_wallets')
      .select('id,address,wallet_address,encrypted_private_key,status')
      .eq('id', intent.vault_wallet_id)
      .eq('user_id', intent.user_id)
      .eq('status', 'active')
      .maybeSingle()
    if (!error && data) return data
  }

  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id,address,wallet_address,encrypted_private_key,status')
    .eq('user_id', intent.user_id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

// ─── Event helper ─────────────────────────────────────────────────────────────

async function insertEvent(supabase, intent, state, message, metadata = {}) {
  await supabase.from('mint_execution_events').insert({
    intent_id: intent.id,
    user_id:   intent.user_id,
    state,
    message,
    metadata,
  }).catch(() => null)
}

// ─── sendAndConfirm ───────────────────────────────────────────────────────────

/**
 * Send a transaction with retry / replacement-tx logic then wait for receipt.
 * Extracted from executeTestnetIntent to be independently testable.
 *
 * On each retry:
 *  - Gas is adaptively escalated (≥10% as required by EIP-1559 replacement rules)
 *  - Nonce is refreshed from the chain (handles nonce_too_low and dropped mempool txs)
 *
 * @param {import('viem').WalletClient} walletClient
 * @param {import('viem').PublicClient} publicClient
 * @param {object} baseTx  — { to, data, value, nonce }
 * @param {{
 *   gasParams: object,
 *   congestionLevel?: string,
 *   maxRetries?: number,
 *   gasCap?: number,
 *   receiptTimeoutMs?: number,
 *   receiptConfirmations?: number,
 *   onSubmit?: (txHash: string, attempt: number) => Promise<void>,
 *   onRetry?: (attempt: number, err: Error, classification: object, newGasParams: object) => Promise<void>,
 * }} options
 * @returns {Promise<{ txHash: string, receipt: object }>}
 */
export async function sendAndConfirm(walletClient, publicClient, baseTx, options = {}) {
  const {
    gasParams,
    congestionLevel    = 'medium',
    maxRetries         = 3,
    gasCap             = GAS_CAP_GWEI,
    receiptTimeoutMs   = RECEIPT_TIMEOUT_MS,
    receiptConfirmations = RECEIPT_CONFIRMATIONS,
    onSubmit           = null,
    onRetry            = null,
  } = options

  // Final safety check — verify the chain ID we're about to use is not mainnet
  assertNotMainnet(walletClient.chain?.id)

  let currentGasParams = { ...gasParams }
  let currentNonce     = baseTx.nonce
  let txHash           = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const gasFields = currentGasParams.isEip1559
        ? {
            maxFeePerGas:         currentGasParams.maxFeePerGas,
            maxPriorityFeePerGas: currentGasParams.maxPriorityFeePerGas,
          }
        : { gasPrice: currentGasParams.gasPrice }

      txHash = await walletClient.sendTransaction({
        ...baseTx,
        ...gasFields,
        nonce: currentNonce,
      })

      nonceTracker.increment(walletClient.account.address)
      if (onSubmit) await onSubmit(txHash, attempt)
      break

    } catch (err) {
      const c = classifyError(err)

      if (!c.retryable || attempt >= maxRetries) throw err

      // Escalate gas for replacement tx — must be ≥10% per EIP-1559 rules
      currentGasParams = adaptiveEscalateGas(currentGasParams, attempt + 1, congestionLevel, gasCap)

      // Always refresh nonce from chain on any retry — safe to over-refresh
      const freshNonce = await publicClient.getTransactionCount({
        address:  walletClient.account.address,
        blockTag: 'pending',
      })
      currentNonce = freshNonce
      nonceTracker.set(walletClient.account.address, freshNonce)

      if (onRetry) await onRetry(attempt, err, c, currentGasParams)
    }
  }

  if (!txHash) throw new Error('No tx hash produced after retry loop')

  const receipt = await publicClient.waitForTransactionReceipt({
    hash:          txHash,
    confirmations: receiptConfirmations,
    timeout:       receiptTimeoutMs,
  })

  return { txHash, receipt }
}

// ─── Main executor ────────────────────────────────────────────────────────────

/**
 * Execute a simulated_success intent as a real transaction on testnet.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} queuedIntent  — intent row with status: simulated_success
 * @returns {Promise<{ intent, txHash, receipt, explorerUrl, latencyMs }|null>}
 */
export async function executeTestnetIntent(supabase, queuedIntent) {
  const log      = createLogger(queuedIntent.id, queuedIntent.user_id)
  const profiler = createProfiler(queuedIntent.id, queuedIntent.user_id)

  // ── Resolve testnet chain (mainnet names redirect to their testnet pair) ─────
  const testnetKey = normalizeTestnetChain(queuedIntent.chain ?? 'eth')
  assertTestnetOnly(testnetKey)

  // ── Safety gates ─────────────────────────────────────────────────────────────
  if (!flagEnabled('TESTNET_EXECUTION_ENABLED')) {
    throw new Error('TESTNET_EXECUTION_ENABLED is off — refusing testnet execution')
  }
  if (FLAGS.LIVE_EXECUTION_ENABLED) {
    throw new Error('LIVE_EXECUTION_ENABLED must be false during testnet execution')
  }

  // ── Duplicate prevention (before claim to avoid unnecessary state transitions) ─
  if (flagEnabled('DUPLICATE_PREVENTION_ENABLED')) {
    await preventDuplicateTx(supabase, queuedIntent.id)
  }

  // ── Atomic claim: simulated_success → executing_testnet ───────────────────
  profiler.phase('claim')
  const intent = await claimForTestnet(supabase, queuedIntent.id)
  if (!intent) {
    log.warn('testnet_claim', 'Intent already claimed — skipping', { intent_id: queuedIntent.id })
    return null
  }

  const startMs = Date.now()

  log.info('testnet_start', 'Testnet execution started', {
    intent_id: intent.id,
    chain:     testnetKey,
    contract:  intent.contract_address ?? intent.mint_contract_address,
  })

  await insertEvent(supabase, intent, 'testnet_start', 'Testnet execution started.', {
    chain:    testnetKey,
    contract: intent.contract_address ?? intent.mint_contract_address,
  })

  try {
    // ── Load vault wallet ───────────────────────────────────────────────────
    profiler.phase('wallet')
    const vaultRow = await loadVaultForIntent(supabase, intent)
    if (!vaultRow?.encrypted_private_key) {
      throw new Error('Alpha Vault wallet not found or inactive — cannot execute on testnet')
    }

    const rawKey    = decryptPrivateKey(vaultRow.encrypted_private_key, intent.user_id)
    const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
    const account   = privateKeyToAccount(privateKey)
    const address   = vaultRow.address || vaultRow.wallet_address || account.address

    log.info('testnet_wallet', 'Vault wallet loaded', { address, intent_id: intent.id })
    await insertEvent(supabase, intent, 'wallet', 'Vault wallet loaded.', { address })

    // ── Build viem clients with testnet chain ─────────────────────────────
    profiler.phase('clients')
    const chainDescriptor = getTestnetChain(testnetKey)

    // Final hard check: we are about to create a client for this chain ID
    assertNotMainnet(chainDescriptor.id)

    const rpcUrls   = getTestnetRpcUrls(testnetKey)
    const transport = http(rpcUrls[0], { timeout: 30_000 })

    const publicClient = createPublicClient({ chain: chainDescriptor, transport })
    const walletClient = createWalletClient({ account, chain: chainDescriptor, transport })

    // ── Gas estimation ────────────────────────────────────────────────────
    profiler.phase('gas')
    const gasStrategy = intent.gas_strategy ?? 'balanced'
    const gasParams   = await estimateGas(publicClient, gasStrategy, 0)
    const congestion  = getCongestionLevel(gasParams.baseFeeGwei)

    profiler.gasEstimate(
      gasParams.strategy,
      gasParams.baseFeeGwei,
      gasParams.maxFeePerGas ? Number(gasParams.maxFeePerGas) / 1e9 : null,
    )

    await insertEvent(supabase, intent, 'gas', 'Gas estimated.', {
      strategy:        gasParams.strategy,
      base_fee_gwei:   gasParams.baseFeeGwei,
      congestion_level: congestion,
      is_eip1559:      gasParams.isEip1559,
    })

    // ── Prepare transaction ───────────────────────────────────────────────
    profiler.phase('prepare')
    const contractAddress = intent.contract_address ?? intent.mint_contract_address
    if (!contractAddress) throw new Error('No contract address on intent')

    const mintPriceStr = intent.mint_price ?? intent.max_mint_price ?? '0'
    const valueWei     = BigInt(Math.round(parseFloat(mintPriceStr) * 1e18))

    const baseTx = {
      to:    contractAddress,
      data:  intent.calldata ?? intent.tx_data ?? '0x',
      value: valueWei,
    }

    // ── Security checks ───────────────────────────────────────────────────
    validateTransaction(baseTx, { allowedChainId: chainDescriptor.id })
    if (flagEnabled('SPEND_CAP_ENABLED')) {
      enforceSpendCap(intent, valueWei)
    }
    if (flagEnabled('CONTRACT_ALLOWLIST_ENABLED')) {
      validateContractAllowlist(contractAddress, testnetKey)
    }

    await insertEvent(supabase, intent, 'prepare', 'Transaction prepared.', {
      to:           contractAddress,
      value_wei:    valueWei.toString(),
      has_calldata: baseTx.data !== '0x',
    })

    // ── Nonce ─────────────────────────────────────────────────────────────
    profiler.phase('nonce')
    let nonce = nonceTracker.get(address)
    if (nonce === undefined) {
      nonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' })
      nonceTracker.set(address, nonce)
      log.info('testnet_nonce', 'Fetched nonce from chain', { address, nonce })
    } else {
      log.info('testnet_nonce', 'Using tracked nonce', { address, nonce })
    }

    await insertEvent(supabase, intent, 'nonce', 'Nonce resolved.', { address, nonce })

    // ── Pre-broadcast simulation ──────────────────────────────────────────
    if (flagEnabled('PRE_BROADCAST_SIMULATION_ENABLED')) {
      profiler.phase('pre_sim')
      const simResult = await preBroadcastSimulate(publicClient, { ...baseTx, from: address })
      if (!simResult.success) {
        if (simResult.isRevert) {
          throw new Error(`Pre-broadcast simulation reverted: ${simResult.revertReason}`)
        }
        log.warn('testnet_presim', 'Pre-broadcast simulation failed (non-revert) — proceeding', {
          reason: simResult.revertReason,
        })
      }
    }

    await logSigningEvent(supabase, {
      intentId: intent.id,
      userId:   intent.user_id,
      address,
      action:   'prepare',
      chain:    testnetKey,
    })

    // ── Send + confirm ────────────────────────────────────────────────────
    profiler.phase('execute')

    const { txHash, receipt } = await sendAndConfirm(
      walletClient,
      publicClient,
      { ...baseTx, nonce },
      {
        gasParams,
        congestionLevel: congestion,
        maxRetries:      3,
        gasCap:          GAS_CAP_GWEI,
        receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
        receiptConfirmations: RECEIPT_CONFIRMATIONS,
        onSubmit: async (hash, attempt) => {
          profiler.rpcCall(address)
          log.info('testnet_submitted', 'Testnet tx submitted', {
            tx_hash:   hash,
            attempt,
            intent_id: intent.id,
            explorer:  getExplorerTxLink(testnetKey, hash),
          })
          await logSigningEvent(supabase, {
            intentId: intent.id,
            userId:   intent.user_id,
            address,
            action:   'broadcast',
            chain:    testnetKey,
            txHash:   hash,
          })
          await insertEvent(supabase, intent, 'testnet_pending', 'Waiting for testnet confirmation.', {
            tx_hash:      hash,
            explorer_url: getExplorerTxLink(testnetKey, hash),
            attempt,
          })
        },
        onRetry: async (attempt, err, c, newGasParams) => {
          const errMsg = String(err?.shortMessage || err?.message || err).slice(0, 240)
          profiler.retry(c.type)
          profiler.gasEscalation()
          await insertEvent(supabase, intent, 'gas_escalation', `Gas escalated for retry #${attempt + 1}.`, {
            attempt,
            error_type:      c.type,
            error:           errMsg,
            congestion_level: congestion,
          })
        },
      },
    )

    // ── Persist receipt ───────────────────────────────────────────────────
    profiler.phase('persist')
    const latencyMs   = Date.now() - startMs
    const blockNumber = receipt.blockNumber.toString()
    const gasUsed     = receipt.gasUsed.toString()
    const explorerUrl = getExplorerTxLink(testnetKey, txHash)

    if (receipt.status === 'reverted') {
      throw new Error(`Transaction reverted on-chain in block ${blockNumber}`)
    }

    await logSigningEvent(supabase, {
      intentId:    intent.id,
      userId:      intent.user_id,
      address,
      action:      'confirmed',
      chain:       testnetKey,
      txHash,
      blockNumber,
    })

    await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING_TESTNET, INTENT_STATES.TESTNET_SUCCESS, {
      tx_hash:        txHash,
      block_number:   blockNumber,
      gas_used:       gasUsed,
      strike_enabled: false,
      last_state:     `Testnet confirmed block ${blockNumber} (${latencyMs}ms)`,
    })

    await insertEvent(supabase, intent, 'testnet_success', 'Testnet transaction confirmed.', {
      tx_hash:      txHash,
      block_number: blockNumber,
      gas_used:     gasUsed,
      latency_ms:   latencyMs,
      explorer_url: explorerUrl,
      chain:        testnetKey,
    })

    const profile = profiler.finish('testnet_success', address)
    recordProfile(profile)
    if (flagEnabled('EXECUTION_TELEMETRY_ENABLED')) await profiler.persist(supabase)

    log.info('testnet_done', 'Testnet execution succeeded', {
      tx_hash:    txHash,
      block:      blockNumber,
      gas_used:   gasUsed,
      latency_ms: latencyMs,
      chain:      testnetKey,
      explorer:   explorerUrl,
    })

    return { intent, txHash, receipt, explorerUrl, latencyMs }

  } catch (err) {
    const errMsg    = String(err?.shortMessage || err?.message || err).slice(0, 240)
    const latencyMs = Date.now() - startMs
    const c         = classifyError(err)

    log.error('testnet_failed', 'Testnet execution failed', {
      error:      errMsg,
      error_type: c.type,
      intent_id:  intent.id,
      latency_ms: latencyMs,
    })

    await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING_TESTNET, INTENT_STATES.TESTNET_FAILED, {
      simulation_error: errMsg,
      last_state:       `Testnet failed: ${errMsg.slice(0, 100)}`,
    }).catch(() => null)

    await insertEvent(supabase, intent, 'testnet_failed', `Testnet execution failed: ${errMsg}`, {
      error:      errMsg,
      error_type: c.type,
      latency_ms: latencyMs,
    }).catch(() => null)

    const profile = profiler.finish(c.type)
    recordProfile(profile)

    throw err
  }
}
