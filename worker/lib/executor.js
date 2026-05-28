/**
 * Main execution unit for the Strike Engine.
 * Ties together: claim → wallet → gas → timing → execute → retry → confirm.
 */

import { createPublicClient, encodeFunctionData, parseAbi } from 'viem'
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
import { invalidateCachedExecution, setCachedExecution } from '../../api/_lib/contract-cache.js'
import { prewarmIntent } from './prewarmer.js'
import { prepareMintTransaction } from '../../api/_lib/mint-engine.js'

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
    to: intent.mint_contract_address || intent.to || intent.contract_address,
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
  // Tracks intent state so the catch block can call transitionIntent with the correct fromState.
  // Initialized to EXECUTING because claim (outside try) must succeed before try runs.
  let currentState = INTENT_STATES.EXECUTING
  // Hoisted so the catch block can include them in failure traces
  let tracedTo = null
  let tracedValue = null
  let tracedGas = null
  let tracedFn = null
  let tracedSource = null

  // ── Step 1: Atomic claim ──────────────────────────────────────────────────
  log.info('claim', 'Attempting to claim intent')
  intent = await claimIntent(supabase, queuedIntent.id)
  if (!intent) {
    log.warn('claim', 'Intent already claimed by another worker — skipping')
    return
  }

  chainKey = normaliseChain(intent.chain)
  const transport = createViemTransport(chainKey)
  const publicClient = createPublicClient({
    chain: buildChainDescriptor(chainKey),
    transport,
  })
  // Load execution profile in parallel with client creation (both are independent)
  executionProfile = await loadExecutionProfile(supabase, {
    chain: chainKey,
    contractAddress: intent.contract_address || intent.mint_contract_address || intent.to,
  })
  const rpcUrls = getRpcUrls(chainKey)
  rpcLabel = executionProfile?.best_rpc || (rpcUrls[0] ? `${chainKey}_rpc` : null)

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

    // ── Steps 3+4: Load wallet + estimate gas in PARALLEL ──────────────────
    // These are independent — no need to wait for wallet before fetching gas.
    // For FCFS intents (have execute_at), force aggressive gas so the tx lands
    // in the first available block, not the second.
    const gasStrategy = intent.gas_strategy
      || (intent.strike_execute_at ? 'aggressive' : 'balanced')
    log.info('prepare', 'Loading execution wallet + estimating gas', { gas_strategy: gasStrategy })
    ;[wallet, gasParams] = await Promise.all([
      loadExecutionWallet(supabase, intent, FLAGS, transport),
      estimateGas(publicClient, gasStrategy, 0),
    ])

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

    // ── Step 6b: Resync on-chain nonce before building tx ──────────────────
    // Always fetch the pending nonce from chain at intent-start so a stale
    // in-process cache (e.g. wallet used outside the worker) never causes
    // "nonce too low" on the first broadcast attempt.
    try {
      const freshNonce = await publicClient.getTransactionCount({
        address: wallet.address,
        blockTag: 'pending',
      })
      nonceTracker.set(wallet.address, freshNonce)
      log.info('prepare', 'Nonce synced from chain', { address: wallet.address, nonce: freshNonce })
    } catch (nonceErr) {
      log.warn('prepare', 'Failed to pre-sync nonce — will fetch inside withRetry', {
        error: nonceErr.message,
      })
    }

    // ── Step 7: Build transaction ───────────────────────────────────────────
    let to = intent.mint_contract_address || intent.to || intent.contract_address
    if (!to) throw new Error('Intent has no contract address (mint_contract_address / to / contract_address)')

    let value = BigInt(intent.mint_price || intent.value || '0')
    let data  = intent.call_data || intent.data || intent.calldata || intent.tx_data || undefined
    let gas   = intent.gas_limit ? BigInt(intent.gas_limit) : undefined

    // ── Step 7b: Inline mint detection fallback ────────────────────────────
    // If call_data is missing (prewarm had no time to run because execute_at
    // was set too close to now), detect the mint function on-the-fly.
    //
    // Strategy: use the WORKER's own publicClient (with the tested RPC transport
    // and fallback URLs) to directly run estimateGas for common mint signatures.
    // This is faster and more reliable than delegating to prepareMintTransaction,
    // which uses mint-engine's own RPC setup that may differ on Railway.
    //
    // If the direct approach fails we fall back to prepareMintTransaction.
    if (!data) {
      log.warn('prepare', 'call_data missing — detecting mint function inline')
      await insertEvent(supabase, intent, 'prewarm', 'call_data missing — detecting mint function inline.', {
        reason: 'execute_at_too_soon',
      }).catch(() => null)
      // Surface progress so the project card doesn't show "preparing execution" for 30s+
      await supabase.from('mint_intents').update({
        last_state: 'Strike worker: detecting mint function...',
        updated_at: new Date().toISOString(),
      }).eq('id', intent.id).then(() => null, () => null)

      const walletAddr = wallet?.address || intent.wallet_address
      const qty = BigInt(Math.max(1, Number(intent.quantity || 1)))
      log.info('prepare', 'Inline detection params', {
        walletAddr: walletAddr?.slice(0, 10),
        contractTo: to?.slice(0, 10),
        valueWei: value.toString(),
        qty: qty.toString(),
        chain: normaliseChain(intent.chain),
      })

      // Ordered by popularity — first success wins
      const INLINE_CANDIDATES = [
        { sig: 'function mint(uint256 quantity) payable',      fn: 'mint',        args: [qty] },
        { sig: 'function publicMint(uint256 quantity) payable', fn: 'publicMint',  args: [qty] },
        { sig: 'function mintPublic(uint256 quantity) payable', fn: 'mintPublic',  args: [qty] },
        { sig: 'function allowlistMint(uint256 quantity) payable', fn: 'allowlistMint', args: [qty] },
        { sig: 'function purchase(uint256 numberOfTokens) payable', fn: 'purchase', args: [qty] },
        { sig: 'function claim(uint256 quantity) payable',     fn: 'claim',       args: [qty] },
        { sig: 'function mintNFT(uint256 quantity) payable',   fn: 'mintNFT',     args: [qty] },
        { sig: 'function freeMint(uint256 quantity) payable',  fn: 'freeMint',    args: [qty] },
        { sig: 'function mint() payable',                      fn: 'mint',        args: [] },
        { sig: 'function claim() payable',                     fn: 'claim',       args: [] },
        { sig: 'function safeMint(address to) payable',        fn: 'safeMint',    args: [walletAddr] },
      ]

      let detectionSuccess = false
      const failedFns = []

      for (const candidate of INLINE_CANDIDATES) {
        try {
          const candidateAbi = parseAbi([candidate.sig])
          const candidateData = encodeFunctionData({
            abi: candidateAbi,
            functionName: candidate.fn,
            args: candidate.args,
          })
          const gasEstimate = await publicClient.estimateGas({
            account: walletAddr,
            to,
            data: candidateData,
            value,
          })
          data = candidateData
          gas  = gasEstimate
          detectionSuccess = true
          log.info('prepare', 'Inline detection succeeded (direct)', {
            fn: candidate.fn, gas: gasEstimate.toString(), triedFirst: failedFns,
          })
          insertEvent(supabase, intent, 'prewarm',
            `Inline detection (direct): ${candidate.fn} (${gasEstimate} gas)`, {
              fn: candidate.fn, gas: gasEstimate.toString(), source: 'inline_direct',
            }).catch(() => null)
          // Persist so future retries skip detection
          supabase.from('mint_intents').update({
            call_data:     data,
            gas_limit:     gasEstimate.toString(),
            function_name: candidate.fn,
          }).eq('id', intent.id).then(() => null, () => null)
          // Write to shared execution cache so the readiness panel reflects this discovery
          setCachedExecution(to, chainKey, {
            functionName: candidate.fn,
            argsSummary:  candidate.args.map(String),
            gas:          gasEstimate.toString(),
            source:       'inline_direct',
          }, supabase)
          break
        } catch (e) {
          const errStr = String(e?.shortMessage || e?.message || '').slice(0, 100)
          failedFns.push(`${candidate.fn}:${errStr}`)
          // Short-circuit: a value-mismatch revert means this is a paid mint.
          // The remaining zero-value candidates will all fail for unrelated reasons
          // (wrong function selector) — skip them so the paid-mint path fires
          // immediately rather than after waiting through all N candidates.
          const PAID_SIGNALS = ['wrong eth', 'incorrect payment', 'wrong value', 'incorrect value', 'msg.value', 'wrong payment']
          if (PAID_SIGNALS.some(p => errStr.toLowerCase().includes(p))) break
        }
      }

      // ── Block-timing retry ───────────────────────────────────────────────
      // Base blocks are ~2s.  If we fire at execute_at == startTime the LATEST
      // confirmed block may have block.timestamp 1-2s behind wall clock, so the
      // contract's `require(block.timestamp >= startTime)` reverts with "not started".
      // Waiting one block (3s) lets the chain advance and the retry succeeds.
      //
      // NOTE: only the function whose ABI matches the contract (usually `mint`) gets
      // the decoded revert reason ("not started").  All wrong-signature candidates
      // return "Execution reverted for an unknown reason", so .every() is always false.
      // We use .some() to trigger the retry when ANY candidate hit a timing-gate error.
      const NOT_STARTED_PATTERNS = ['not started', 'not open', 'not active', 'sale not active', 'mint not active', 'mint has not', 'not yet']
      const anyNotStarted =
        failedFns.length > 0 &&
        failedFns.some(f => NOT_STARTED_PATTERNS.some(p => f.toLowerCase().includes(p)))

      // Only trigger the block-timing retry if we fired within 5 s of execute_at.
      // When execute_at is far from now (e.g. startTime is genuinely in the future),
      // "not started" is a real gate and waiting 3 s won't help — skip straight to
      // the paid-mint fallback and prepareMintTransaction instead.
      const msSinceExec = executeAt ? (Date.now() - executeAt) : 0
      const likelyTimingLag = msSinceExec < 5000
      if (!detectionSuccess && anyNotStarted && likelyTimingLag) {
        const BLOCK_WAIT_MS = 3000
        log.warn('prepare', 'At least one candidate failed with "not started" — likely block-timestamp lag at T=0, waiting for next block', {
          wait_ms: BLOCK_WAIT_MS, ms_since_exec: msSinceExec, failures: failedFns,
        })
        await insertEvent(supabase, intent, 'prewarm',
          '⏳ Mint start-time gate — waiting for next block before retrying...', {
            reason: 'not_started_block_timing_retry', wait_ms: BLOCK_WAIT_MS, ms_since_exec: msSinceExec,
          }).catch(() => null)
        // Surface progress update so the project card reflects the wait
        await supabase.from('mint_intents').update({
          last_state: '⏳ Strike: waiting for mint start gate (next block)...',
          updated_at: new Date().toISOString(),
        }).eq('id', intent.id).then(() => null, () => null)

        await new Promise(resolve => setTimeout(resolve, BLOCK_WAIT_MS))

        const retryFailedFns = []
        for (const candidate of INLINE_CANDIDATES) {
          try {
            const candidateAbi  = parseAbi([candidate.sig])
            const candidateData = encodeFunctionData({ abi: candidateAbi, functionName: candidate.fn, args: candidate.args })
            const gasEstimate   = await publicClient.estimateGas({ account: walletAddr, to, data: candidateData, value })
            data = candidateData
            gas  = gasEstimate
            detectionSuccess = true
            log.info('prepare', 'Inline detection succeeded after block-timing retry', {
              fn: candidate.fn, gas: gasEstimate.toString(),
            })
            insertEvent(supabase, intent, 'prewarm',
              `Inline detection (block-retry): ${candidate.fn} (${gasEstimate} gas)`, {
                fn: candidate.fn, gas: gasEstimate.toString(), source: 'inline_block_retry',
              }).catch(() => null)
            supabase.from('mint_intents').update({
              call_data:     data,
              gas_limit:     gasEstimate.toString(),
              function_name: candidate.fn,
            }).eq('id', intent.id).then(() => null, () => null)
            break
          } catch (e) {
            retryFailedFns.push(`${candidate.fn}:${String(e?.shortMessage || e?.message || '').slice(0, 100)}`)
          }
        }
        if (!detectionSuccess) failedFns.push(...retryFailedFns)
      }

      // ── Paid mint fallback ────────────────────────────────────────────────
      // If all zero-value attempts failed with "wrong ETH", the contract has a
      // non-zero mintPrice.  Read it directly and retry with the correct value.
      if (!detectionSuccess && failedFns.some(f => f.toLowerCase().includes('wrong eth'))) {
        try {
          const mintPriceAbi = parseAbi(['function mintPrice() view returns (uint256)'])
          const onChainPrice = await publicClient.readContract({
            address: to, abi: mintPriceAbi, functionName: 'mintPrice',
          })
          if (onChainPrice > 0n) {
            const paidValue = onChainPrice * qty
            log.info('prepare', 'Paid mint detected — retrying with on-chain price', {
              mintPrice: onChainPrice.toString(), paidValue: paidValue.toString(),
            })
            const paidFailures = []
            for (const candidate of INLINE_CANDIDATES) {
              try {
                const candidateAbi  = parseAbi([candidate.sig])
                const candidateData = encodeFunctionData({
                  abi: candidateAbi, functionName: candidate.fn, args: candidate.args,
                })
                const gasEstimate = await publicClient.estimateGas({
                  account: walletAddr, to, data: candidateData, value: paidValue,
                })
                data  = candidateData
                gas   = gasEstimate
                value = paidValue   // update value for the actual tx
                detectionSuccess = true
                log.info('prepare', 'Paid inline detection succeeded', {
                  fn: candidate.fn, gas: gasEstimate.toString(), paidValue: paidValue.toString(),
                })
                insertEvent(supabase, intent, 'prewarm',
                  `Inline detection (paid): ${candidate.fn} (${gasEstimate} gas, price=${onChainPrice})`, {
                    fn: candidate.fn, gas: gasEstimate.toString(),
                    mint_price: onChainPrice.toString(), source: 'inline_paid',
                  }).catch(() => null)
                supabase.from('mint_intents').update({
                  call_data:     data,
                  gas_limit:     gasEstimate.toString(),
                  function_name: candidate.fn,
                  mint_price:    onChainPrice.toString(),
                }).eq('id', intent.id).then(() => null, () => null)
                // Write to shared execution cache so the readiness panel reflects this discovery
                setCachedExecution(to, chainKey, {
                  functionName: candidate.fn,
                  argsSummary:  candidate.args.map(String),
                  gas:          gasEstimate.toString(),
                  source:       'inline_paid',
                }, supabase)
                break
              } catch (e) {
                paidFailures.push(`${candidate.fn}:${String(e?.shortMessage || e?.message || '').slice(0, 100)}`)
              }
            }
            if (!detectionSuccess) failedFns.push(...paidFailures)
          }
        } catch {
          // mintPrice() not available on this contract — continue to full fallback
        }
      }

      // Fallback: delegate to prepareMintTransaction (full detection pipeline)
      if (!detectionSuccess) {
        log.warn('prepare', 'Direct detection failed for all candidates — falling back to prepareMintTransaction', {
          failedFns,
        })
        try {
          const mintPriceEth = value === 0n ? '0' : String(Number(value) / 1e18)
          const prepared = await prepareMintTransaction({
            chain:           normaliseChain(intent.chain),
            contractAddress: to,
            walletAddress:   walletAddr,
            mintPrice:       mintPriceEth,
            quantity:        Number(qty),
          }, null, supabase)

          data  = prepared.data
          gas   = prepared.gas  ? BigInt(prepared.gas)   : gas
          to    = prepared.to   || to
          value = prepared.value ? BigInt(prepared.value) : value
          detectionSuccess = true

          log.info('prepare', 'Fallback detection succeeded (prepareMintTransaction)', {
            fn: prepared.functionName, gas: prepared.gas,
          })
          await insertEvent(supabase, intent, 'prewarm',
            `Inline detection (fallback): ${prepared.functionName} (${prepared.gas} gas, source=${prepared.source})`, {
              fn: prepared.functionName, gas: prepared.gas, source: prepared.source,
            }).catch(() => null)
          supabase.from('mint_intents').update({
            call_data:     data,
            gas_limit:     prepared.gas,
            to:            prepared.to,
            value:         prepared.value,
            function_name: prepared.functionName,
          }).eq('id', intent.id).then(() => null, () => null)

        } catch (detectionErr) {
          const detectionMsg = String(detectionErr?.shortMessage || detectionErr?.message || detectionErr).slice(0, 200)
          const rawReason    = detectionErr?.rawReason?.slice?.(0, 200) || null
          log.error('prepare', 'All inline detection paths failed', {
            error: detectionMsg, rawReason, failedDirectFns: failedFns,
          })
          await insertEvent(supabase, intent, 'prewarm_failed',
            'Inline mint detection failed — cannot build transaction.', {
              error:           detectionMsg,
              raw_reason:      rawReason,
              direct_failures: failedFns,
            }).catch(() => null)
          throw new Error(`Mint function detection failed: ${detectionMsg}`)
        }
      }
    }

    // Populate trace vars for use in the catch block
    tracedTo     = to
    tracedValue  = value.toString()
    tracedGas    = gas?.toString() || null
    tracedFn     = intent.function_name || (data ? 'prewarmed' : null)
    tracedSource = data ? 'prewarm_cache' : null

    const baseTx = {
      to,
      value,
      ...(data ? { data } : {}),
      ...(gas ? { gas } : {}),
    }

    const gasFields = gasParams.isEip1559
      ? { maxFeePerGas: gasParams.maxFeePerGas, maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas }
      : { gasPrice: gasParams.gasPrice }

    // Surface final pre-send status (fire-and-forget — never delay the broadcast)
    supabase.from('mint_intents').update({
      last_state: 'Strike worker: broadcasting transaction...',
      updated_at: new Date().toISOString(),
    }).eq('id', intent.id).then(r => r, () => null)
    insertEvent(supabase, intent, 'simulate', 'Broadcasting Strike transaction.', {
      chain: chainKey,
      fn: tracedFn,
      source: tracedSource,
      to: to.slice(0, 10),
      value: tracedValue,
      gas: tracedGas,
      strategy: gasParams.strategy,
      base_fee_gwei: gasParams.baseFeeGwei,
    }).catch(() => null)

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

          // Mark as retrying via state machine (first retry: EXECUTING → RETRYING;
          // subsequent retries: already in RETRYING, just update last_state)
          if (attempt === 0) {
            await transitionIntent(supabase, intent.id, INTENT_STATES.EXECUTING, INTENT_STATES.RETRYING, {
              last_state: `Retry ${attempt + 1}: ${classification.type}`,
            }).catch(() => null)
            currentState = INTENT_STATES.RETRYING
          } else {
            await supabase.from('mint_intents').update({
              last_state: `Retry ${attempt + 1}: ${classification.type}`,
              updated_at: now(),
            }).eq('id', intent.id).then(r => r, () => null)
          }
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
    currentState = INTENT_STATES.PENDING
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

      // ── Telegram notification ──────────────────────────────────────────────
      // Fire-and-forget — never let a notification failure kill the success path
      ;(async () => {
        try {
          const botToken = process.env.TELEGRAM_BOT_TOKEN
          if (!botToken) return
          const { data: profile } = await supabase
            .from('profiles')
            .select('telegram_chat_id')
            .eq('id', intent.user_id)
            .maybeSingle()
          const chatId = profile?.telegram_chat_id
          if (!chatId) return
          const CHAIN_EXPLORERS = {
            base: 'https://basescan.org',
            eth:  'https://etherscan.io',
            bnb:  'https://bscscan.com',
            apechain: 'https://apescan.io',
          }
          const explorerBase = CHAIN_EXPLORERS[chainKey] || 'https://basescan.org'
          const projectLabel = intent.project_name || intent.contract_address?.slice(0, 10) || 'Strike'
          const msg = [
            `✅ <b>Mint successful: ${projectLabel}</b>`,
            ``,
            `TX: <code>${txHash}</code>`,
            `<a href="${explorerBase}/tx/${txHash}">View on explorer →</a>`,
          ].join('\n')
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
          })
        } catch (tgErr) {
          log.warn('notify', 'Telegram notification failed (non-fatal)', { error: String(tgErr?.message || tgErr).slice(0, 80) })
        }
      })()

    } else if (recovery.status === 'reverted' || recovery.status === 'dropped') {
      if (recovery.status === 'reverted') {
        // Cached function/gas may be wrong — force fresh detection next time
        invalidateCachedExecution(
          intent.contract_address || intent.to || intent.mint_contract_address,
          chainKey,
        )
      }
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
    await transitionIntent(supabase, intent.id, currentState, INTENT_STATES.FAILED, {
      strike_enabled: false,
      strike_error: message,
      simulation_status: 'failed',
      simulation_error: message,
      last_state: `Strike failed: ${message.slice(0, 120)}`,
    }).catch(() => null)
    await insertEvent(
      supabase,
      intent,
      'failed',
      'Strike failed safely. No duplicate transaction will be sent.',
      {
        error: message,
        raw_error: (err?.rawReason || err?.message || '').slice(0, 300),
        error_type: classification.type,
        fn: tracedFn,
        source: tracedSource,
        to: tracedTo?.slice(0, 10),
        value: tracedValue,
        gas: tracedGas,
        chain: chainKey,
        rpc: rpcLabel,
        latency_ms: latencyMs,
      },
    ).catch(() => null)
  }
}
