import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { prepareMintTransaction } from '../api/_lib/mint-engine.js'
import {
  confirmationTimeoutMs,
  loadExecutionProfile,
  optimizationTelemetry,
  orderRpcCandidates,
  recordExecutionOptimization,
  rpcTimeoutMs,
} from '../api/_lib/execution-optimizer.js'
import {
  classifyTxError,
  recordTxState,
  waitForReceiptWithRecovery,
} from './lib/tx-resilience.js'

// ── New lib modules (loaded dynamically so engine still starts if files are missing) ──
let FLAGS = null
let flagEnabled = null
let log = null
let fetchReadyIntents = null
let fetchPrewarmIntents = null
let markExpired = null
let executeIntent = null
let simulateArmedIntent = null
let runSimulationRequeueSweep = null
let isExpired = null
let PREWARM_WINDOW_MS = 30_000

try {
  const flagsMod = await import('./lib/flags.js')
  FLAGS = flagsMod.FLAGS
  flagEnabled = flagsMod.flagEnabled
} catch { /* lib not available */ }

try {
  const logMod = await import('./lib/logger.js')
  log = logMod.log
} catch { /* lib not available */ }

try {
  const queueMod = await import('./lib/queue.js')
  fetchReadyIntents = queueMod.fetchReadyIntents
  fetchPrewarmIntents = queueMod.fetchPrewarmIntents
  markExpired = queueMod.markExpired
} catch { /* lib not available */ }

try {
  const execMod = await import('./lib/executor.js')
  executeIntent = execMod.executeIntent
} catch { /* lib not available */ }

try {
  const simMod = await import('./lib/sim-executor.js')
  simulateArmedIntent = simMod.simulateArmedIntent
  runSimulationRequeueSweep = simMod.runSimulationRequeueSweep
} catch { /* lib not available */ }

let executeTestnetIntent = null
let fetchTestnetReadyIntents = null
try {
  const testnetMod = await import('./lib/testnet-executor.js')
  executeTestnetIntent     = testnetMod.executeTestnetIntent
  fetchTestnetReadyIntents = testnetMod.fetchTestnetReadyIntents
} catch { /* lib not available */ }

let getSessionTelemetry = null
try {
  const profilerMod = await import('./lib/profiler.js')
  getSessionTelemetry = profilerMod.getSessionTelemetry
} catch { /* lib not available */ }

let acquireLease = null
let renewLease = null
try {
  const leaseMod = await import('./lib/lease.js')
  acquireLease = leaseMod.acquireLease
  renewLease   = leaseMod.renewLease
} catch { /* lib not available */ }

let prewarmIntent = null
try {
  const prewarmMod = await import('./lib/prewarmer.js')
  prewarmIntent = prewarmMod.prewarmIntent
} catch { /* lib not available */ }

let reconcileQueue = null
try {
  const recoveryMod = await import('./lib/recovery.js')
  reconcileQueue = recoveryMod.reconcileQueue
} catch { /* lib not available */ }

let getRpcHealth = null
let persistRpcHealth = null
let loadPersistedRpcHealth = null
try {
  const rpcMod = await import('./lib/rpc.js')
  getRpcHealth = rpcMod.getRpcHealth
  persistRpcHealth = rpcMod.persistRpcHealth
  loadPersistedRpcHealth = rpcMod.loadPersistedRpcHealth
} catch { /* lib not available */ }

try {
  const timingMod = await import('./lib/timing.js')
  isExpired = timingMod.isExpired
  PREWARM_WINDOW_MS = timingMod.PREWARM_WINDOW_MS
} catch { /* lib not available */ }

// ── Config ────────────────────────────────────────────────────────────────────

const LOOP_MS = Number(process.env.STRIKE_WORKER_INTERVAL_MS || 2000)
const BATCH_SIZE = Number(process.env.STRIKE_WORKER_BATCH_SIZE || 3)
const RUN_ONCE = String(process.env.STRIKE_WORKER_RUN_ONCE || '').toLowerCase() === 'true'

// Original safety flags — kept for backward compatibility
const AUTO_STRIKE_ENABLED = String(process.env.AUTO_STRIKE_ENABLED || '').toLowerCase() === 'true'
const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'

const CHAIN_RPCS = {
  eth: [
    { label: 'ETH_RPC_URL', url: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com' },
    { label: 'ETH_RPC_URL_FALLBACK_1', url: process.env.ETH_RPC_URL_FALLBACK_1 || '' },
    { label: 'ETH_RPC_URL_FALLBACK_2', url: process.env.ETH_RPC_URL_FALLBACK_2 || '' },
  ],
  base: [
    { label: 'BASE_RPC_URL', url: process.env.BASE_RPC_URL || 'https://mainnet.base.org' },
    { label: 'BASE_RPC_URL_FALLBACK_1', url: process.env.BASE_RPC_URL_FALLBACK_1 || '' },
    { label: 'BASE_RPC_URL_FALLBACK_2', url: process.env.BASE_RPC_URL_FALLBACK_2 || '' },
  ],
  apechain: [
    { label: 'APECHAIN_RPC_URL', url: process.env.APECHAIN_RPC_URL || '' },
    { label: 'APECHAIN_RPC_URL_FALLBACK_1', url: process.env.APECHAIN_RPC_URL_FALLBACK_1 || '' },
    { label: 'APECHAIN_RPC_URL_FALLBACK_2', url: process.env.APECHAIN_RPC_URL_FALLBACK_2 || '' },
  ],
}
const CHAIN_RPC = Object.fromEntries(
  Object.entries(CHAIN_RPCS).map(([chain, urls]) => [chain, urls.find(item => item.url)?.url || '']),
)

const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  apechain: 33139,
}

let stopping = false
let tickCount = 0
const HEARTBEAT_INTERVAL = Number(process.env.STRIKE_WORKER_HEARTBEAT_INTERVAL || 10)

// ── Logging (falls back to plain console if lib not loaded) ───────────────────

function legacyLog(...args) {
  console.log(new Date().toISOString(), '[strike-worker]', ...args)
}

function workerLog(phase, message, fields = {}) {
  if (log) {
    log.info(phase, message, fields)
  } else {
    legacyLog(message, fields)
  }
}

function workerWarn(phase, message, fields = {}) {
  if (log) {
    log.warn(phase, message, fields)
  } else {
    legacyLog('[WARN]', message, fields)
  }
}

function workerError(phase, message, fields = {}) {
  if (log) {
    log.error(phase, message, fields)
  } else {
    console.error(new Date().toISOString(), '[strike-worker] [ERROR]', message, fields)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Environment validation ────────────────────────────────────────────────────

function envReady() {
  const missing = []
  if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!process.env.ALPHA_VAULT_ENCRYPTION_KEY && !process.env.WALLET_ENCRYPTION_KEY) missing.push('ALPHA_VAULT_ENCRYPTION_KEY')
  return missing
}

function supabaseClient() {
  return createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

// ── Legacy helpers (kept for backward compat when lib is missing) ─────────────

function normalizeChain(chain = 'eth') {
  const text = String(chain || '').toLowerCase()
  if (text.includes('base')) return 'base'
  if (text.includes('ape')) return 'apechain'
  return 'eth'
}

function chainObject(chain, rpcUrl = CHAIN_RPC[chain]) {
  const id = CHAIN_IDS[chain] || 1
  return {
    id,
    name: chain === 'base' ? 'Base' : chain === 'apechain' ? 'ApeChain' : 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl].filter(Boolean) } },
  }
}

function decryptPrivateKey(encrypted, userId) {
  const secret = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  const key = crypto.pbkdf2Sync(secret, userId, 100000, 32, 'sha256')
  const packed = Buffer.from(encrypted, 'base64')
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const data = packed.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

async function insertEvent(supabase, intent, state, message, metadata = {}) {
  await supabase.from('mint_execution_events').insert({
    intent_id: intent.id,
    user_id: intent.user_id,
    state,
    message,
    metadata,
  }).throwOnError()
}

async function recordAttempt(supabase, intent, status, patch = {}) {
  await supabase.from('mint_attempts').insert({
    intent_id: intent.id,
    mint_intent_id: intent.id,
    user_id: intent.user_id,
    status,
    ...patch,
  }).throwOnError()
}

async function loadIntentVault(supabase, intent) {
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
  return data?.[0] || null
}

// ── Legacy execution path (used when lib/executor.js is not available) ────────

async function legacyClaimIntent(supabase, intent) {
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status: 'executing',
      last_state: 'Preparing Strike transaction',
      updated_at: new Date().toISOString(),
    })
    .eq('id', intent.id)
    .eq('strike_enabled', true)
    .in('status', ['armed', 'watching', 'prepared'])
    .select()
    .single()
  if (error || !data) return null
  return data
}

async function legacyProcessIntent(supabase, queuedIntent) {
  const intent = await legacyClaimIntent(supabase, queuedIntent)
  if (!intent) return

  let selectedRpc = null
  let prepared = null
  let prepareLatencyMs = null
  let executionProfile = null
  let chain = normalizeChain(intent.chain)
  let currentNonce = null
  let txHash = null

  try {
    await insertEvent(supabase, intent, 'preparing', 'Strike worker is preparing the mint.')
    const vault = await loadIntentVault(supabase, intent)
    if (!vault?.encrypted_private_key) throw new Error('Alpha Vault is not ready.')

    const privateKey = decryptPrivateKey(vault.encrypted_private_key, intent.user_id)
    const account = privateKeyToAccount(privateKey)
    executionProfile = await loadExecutionProfile(supabase, {
      chain,
      contractAddress: intent.contract_address,
    })
    const rpcCandidates = orderRpcCandidates(chain, executionProfile, CHAIN_RPCS[chain] || [])
    if (!rpcCandidates.length) throw new Error('Strike RPC is not configured for this chain.')

    // Fast path: use prewarmed call_data + gas_limit if available (skips RPC function detection).
    // 'to' may be the SeaDrop router (not the NFT contract) — use intent.to when set.
    // 'value' is the exact wei amount stored by prewarm — required for paid mints.
    if (intent.call_data) {
      selectedRpc = rpcCandidates[0]
      const startedAt = Date.now()
      prepared = {
        to: intent.to || intent.contract_address,
        data: intent.call_data,
        value: intent.value || '0',
        gas: intent.gas_limit || null,
        functionName: intent.function_name || 'prewarmed',
        source: 'prewarm_cache',
        optimized: Boolean(executionProfile?.success_count),
        readinessBoost: 0,
      }
      prepareLatencyMs = Date.now() - startedAt
      workerLog('prewarm', 'Using prewarmed call_data — skipping function detection', {
        intent_id: intent.id,
        to: prepared.to?.slice(0, 10),
        value: prepared.value,
        gas: intent.gas_limit,
        rpc: selectedRpc?.label,
      })
    } else {
      let lastPrepareError = null
      for (const candidate of rpcCandidates) {
        const startedAt = Date.now()
        try {
          prepared = await prepareMintTransaction({
            ...intent,
            walletAddress: account.address,
            mintPrice: intent.max_mint_price || '0',
            maxTotalSpend: intent.max_total_spend,
            rpcUrl: candidate.url,
            rpcLabel: candidate.label,
            executionProfile,
          })
          selectedRpc = candidate
          prepareLatencyMs = Date.now() - startedAt
          break
        } catch (error) {
          lastPrepareError = error
          await recordExecutionOptimization(supabase, {
            intent,
            chain,
            contractAddress: intent.contract_address,
            status: 'failed',
            latencyMs: Date.now() - startedAt,
            errorMessage: String(error?.message || error).slice(0, 180),
            rpcLabel: candidate.label,
          })
        }
      }
      if (!prepared || !selectedRpc) throw lastPrepareError || new Error('Strike preparation failed.')
    }
    if (prepared.optimized || executionProfile?.success_count) {
      await insertEvent(supabase, intent, 'optimized', 'Execution profile loaded for this contract.', {
        ...optimizationTelemetry(executionProfile, {
          chain,
          contractAddress: intent.contract_address,
          bestRpc: selectedRpc.label,
        }),
        readinessBoost: prepared.readinessBoost,
      })
    }
    await insertEvent(supabase, intent, 'simulating', 'Mint simulation passed. Broadcasting Strike transaction.', {
      functionName: prepared.functionName,
      chainId: prepared.chainId,
      rpc: selectedRpc.label,
    })

    const walletClient = createWalletClient({
      account,
      chain: chainObject(chain, selectedRpc.url),
      transport: http(selectedRpc.url, { timeout: rpcTimeoutMs(executionProfile, 10000) }),
    })
    const publicClient = createPublicClient({
      chain: chainObject(chain, selectedRpc.url),
      transport: http(selectedRpc.url, { timeout: rpcTimeoutMs(executionProfile, 10000) }),
    })

    currentNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
    txHash = await walletClient.sendTransaction({
      to: prepared.to,
      data: prepared.data,
      value: BigInt(prepared.value || '0'),
      gas: prepared.gas ? BigInt(prepared.gas) : undefined,
      nonce: currentNonce,
    })

    await recordAttempt(supabase, intent, 'submitted', { tx_hash: txHash })
    await recordTxState(supabase, intent, 'pending', {
      txHash,
      chain,
      nonce: currentNonce,
      gas: prepared.gas,
      reason: 'legacy_worker_submission',
      message: 'Transaction submitted and waiting for confirmation.',
    })
    await recordExecutionOptimization(supabase, {
      intent,
      chain,
      contractAddress: intent.contract_address,
      status: 'submitted',
      latencyMs: prepareLatencyMs,
      gasUsed: prepared.gas,
      functionName: prepared.functionName,
      functionSource: prepared.source,
      rpcLabel: selectedRpc.label,
    })
    await supabase.from('mint_intents').update({
      status: 'submitted',
      tx_hash: txHash,
      last_state: 'Strike transaction submitted',
      updated_at: new Date().toISOString(),
    }).eq('id', intent.id).throwOnError()
    await insertEvent(supabase, intent, 'submitted', 'Strike transaction submitted.', { txHash })
    const recovery = await waitForReceiptWithRecovery({
      supabase,
      intent,
      publicClient,
      txHash,
      chain,
      nonce: currentNonce,
      walletAddress: account.address,
      timeoutMs: confirmationTimeoutMs(executionProfile),
    })
    if (recovery.status === 'confirmed') {
      const receipt = recovery.receipt
      await recordAttempt(supabase, intent, 'confirmed', { tx_hash: txHash, gas_used: receipt?.gasUsed?.toString?.() })
      await insertEvent(supabase, intent, 'confirmed', 'Strike transaction confirmed.', {
        txHash,
        confirmationMs: recovery.latencyMs,
      })
      await recordExecutionOptimization(supabase, {
        intent,
        chain,
        contractAddress: intent.contract_address,
        status: 'confirmed',
        confirmationMs: recovery.latencyMs,
        gasUsed: receipt?.gasUsed?.toString?.() || prepared.gas,
        functionName: prepared.functionName,
        functionSource: prepared.source,
        rpcLabel: selectedRpc.label,
      })
    }
    legacyLog('submitted', intent.id, txHash)
  } catch (error) {
    const message = String(error?.shortMessage || error?.message || 'Strike execution failed.').slice(0, 240)
    await recordTxState(supabase, intent, classifyTxError(error) === 'dropped' ? 'dropped' : 'recovering', {
      txHash,
      chain,
      nonce: currentNonce,
      error: message,
      reason: classifyTxError(error),
      message: 'Transaction recovery recorded after execution failure.',
    }).catch(() => null)
    await recordExecutionOptimization(supabase, {
      intent,
      chain,
      contractAddress: intent.contract_address,
      status: 'failed',
      latencyMs: prepareLatencyMs,
      gasUsed: prepared?.gas,
      functionName: prepared?.functionName,
      functionSource: prepared?.source,
      rpcLabel: selectedRpc?.label,
      errorMessage: message,
    })
    await recordAttempt(supabase, intent, 'failed', { error_message: message }).catch(() => null)
    await supabase.from('mint_intents').update({
      status: 'failed',
      strike_enabled: false,
      simulation_status: 'failed',
      simulation_error: message,
      last_state: 'Strike failed safely',
      updated_at: new Date().toISOString(),
    }).eq('id', intent.id).catch(() => null)
    await insertEvent(supabase, intent, 'failed', 'Strike failed safely. No duplicate transaction will be sent.', { error: message }).catch(() => null)
    legacyLog('failed', intent.id, message)
  }
}

// ── Expiration sweep ──────────────────────────────────────────────────────────

async function sweepExpiredIntents(supabase) {
  // Only sweep if timing and queue libs are loaded
  if (!isExpired || !markExpired) return

  const nowMs = Date.now()
  const { data, error } = await supabase
    .from('mint_intents')
    .select('id,user_id,strike_execute_at,status')
    .eq('strike_enabled', true)
    .in('status', ['armed', 'watching', 'prepared'])
    .not('strike_execute_at', 'is', null)
    .limit(20)

  if (error) {
    workerWarn('tick', 'Failed to query for expired intents', { error: error.message })
    return
  }

  const expiredIntents = (data || []).filter(intent =>
    isExpired(new Date(intent.strike_execute_at).getTime(), nowMs),
  )

  for (const intent of expiredIntents) {
    workerLog('expired', 'Sweeping expired intent', { intent_id: intent.id })
    await markExpired(supabase, intent).catch(err =>
      workerError('expired', 'Failed to mark intent expired', { intent_id: intent.id, error: err.message }),
    )
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick(supabase) {
  tickCount++

  const liveEnabled     = FLAGS?.LIVE_EXECUTION_ENABLED     ?? false
  const simMode         = FLAGS?.SIMULATION_MODE             ?? false
  const testnetEnabled  = FLAGS?.TESTNET_EXECUTION_ENABLED   ?? false

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  if (tickCount === 1 || tickCount % HEARTBEAT_INTERVAL === 0) {
    workerLog('tick', 'Worker heartbeat', {
      tick:                    tickCount,
      live_execution:          liveEnabled,
      simulation_mode:         simMode,
      testnet_execution:       testnetEnabled,
      auto_strike:             AUTO_STRIKE_ENABLED,
      alpha_vault:             ALPHA_VAULT_ENABLED,
      sim_executor_loaded:     Boolean(simulateArmedIntent),
      testnet_executor_loaded: Boolean(executeTestnetIntent),
      executor_loaded:         Boolean(executeIntent),
      telemetry:            getSessionTelemetry ? getSessionTelemetry() : null,
      rpc_health:           getRpcHealth ? getRpcHealth().slice(0, 5) : null,
    })
    if (persistRpcHealth && supabase) {
      await persistRpcHealth(supabase).catch(() => null)
    }
    if (renewLease && supabase && (FLAGS?.LEASE_ENABLED ?? false)) {
      await renewLease(supabase).catch(() => null)
    }
    if (reconcileQueue && supabase && (FLAGS?.ORPHAN_RECOVERY_ENABLED ?? true)) {
      await reconcileQueue(supabase).catch(() => null)
    }
  }

  // ── Central LIVE_EXECUTION_ENABLED enforcement ──────────────────────────────
  // If live execution is requested, require both legacy safety switches to be on.
  if (liveEnabled && (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED)) {
    workerWarn('tick', 'LIVE_EXECUTION_ENABLED=true but safety switches are off — refusing live execution', {
      auto_strike: AUTO_STRIKE_ENABLED,
      alpha_vault: ALPHA_VAULT_ENABLED,
    })
    return
  }

  // If nothing is enabled, idle.
  if (!liveEnabled && !simMode && !testnetEnabled) {
    workerLog('tick', 'idle: LIVE_EXECUTION_ENABLED=false and SIMULATION_MODE=false and TESTNET_EXECUTION_ENABLED=false')
    return
  }

  const nowMs = Date.now()

  // ── Expiration sweep ────────────────────────────────────────────────────────
  await sweepExpiredIntents(supabase)

  // ── Simulation requeue sweep ────────────────────────────────────────────────
  if (simMode && runSimulationRequeueSweep) {
    try {
      const requeued = await runSimulationRequeueSweep(supabase, BATCH_SIZE)
      if (requeued > 0) {
        workerLog('tick', 'Requeued failed simulation intents', { count: requeued })
      }
    } catch (err) {
      workerWarn('tick', 'Simulation requeue sweep failed', { error: err.message })
    }
  }

  // ── Testnet execution sweep ─────────────────────────────────────────────────
  if (testnetEnabled && !liveEnabled && executeTestnetIntent && fetchTestnetReadyIntents) {
    try {
      const testnetIntents = await fetchTestnetReadyIntents(supabase, BATCH_SIZE)
      if (testnetIntents.length) {
        workerLog('tick', 'Processing testnet intents', { count: testnetIntents.length })
        for (const intent of testnetIntents) {
          await executeTestnetIntent(supabase, intent).catch(err =>
            workerError('testnet', 'Testnet execution error', {
              intent_id: intent.id,
              error:     String(err?.message || err),
            }),
          )
        }
      }
    } catch (err) {
      workerWarn('tick', 'Testnet sweep failed', { error: err.message })
    }
  }

  // ── Prewarm phase ───────────────────────────────────────────────────────────
  if (fetchPrewarmIntents && flagEnabled) {
    try {
      const prewarmIntents = await fetchPrewarmIntents(supabase, PREWARM_WINDOW_MS, nowMs)
      if (prewarmIntents.length) {
        workerLog('prewarm', 'Intents in prewarm window', {
          count: prewarmIntents.length,
          prewarm_window_ms: PREWARM_WINDOW_MS,
        })
        for (const intent of prewarmIntents) {
          const msUntil = new Date(intent.strike_execute_at).getTime() - nowMs
          workerLog('prewarm', 'Intent approaching execution window', {
            intent_id: intent.id,
            ms_until_execute: msUntil,
            execute_at: intent.strike_execute_at,
          })
          if (prewarmIntent) {
            prewarmIntent(supabase, intent).then(result => {
              if (result.ok) {
                workerLog('prewarm', 'Prewarm succeeded', {
                  intent_id:    intent.id,
                  fn:           result.functionName,
                  cache_hit:    result.cacheHit,
                  latency_ms:   result.latencyMs,
                  confidence:   result.confidence,
                })
              } else {
                workerWarn('prewarm', 'Prewarm failed (non-fatal)', {
                  intent_id: intent.id,
                  error:     result.error,
                })
              }
            }).catch(() => null)
          }
        }
      }
    } catch (err) {
      workerWarn('tick', 'Prewarm query failed', { error: err.message })
    }
  }

  // ── Fetch ready intents ─────────────────────────────────────────────────────
  let readyIntents = []
  let usedLibPath = false

  if (fetchReadyIntents) {
    try {
      readyIntents = await fetchReadyIntents(supabase, BATCH_SIZE, nowMs)
      usedLibPath = true
    } catch (err) {
      workerWarn('tick', 'fetchReadyIntents failed, falling back to legacy query', { error: err.message })
    }
  }

  if (!usedLibPath) {
    const { data, error } = await supabase
      .from('mint_intents')
      .select('*')
      .eq('strike_enabled', true)
      .in('status', ['armed', 'watching', 'prepared'])
      .order('updated_at', { ascending: true })
      .limit(BATCH_SIZE)

    if (error) throw error
    const now = Date.now()
    readyIntents = (data || []).filter(intent => {
      if (!intent.strike_execute_at) return true
      const executeAt = new Date(intent.strike_execute_at).getTime()
      return Number.isNaN(executeAt) || executeAt <= now
    })
  }

  if (readyIntents.length === 0) {
    workerLog('tick', 'idle', { live: liveEnabled, sim: simMode })
    return
  }

  workerLog('tick', 'Processing intents', {
    count: readyIntents.length,
    live_enabled: liveEnabled,
    sim_mode: simMode,
  })

  // ── Dispatch: simulation or live ────────────────────────────────────────────
  for (const intent of readyIntents) {
    if (simMode && !liveEnabled && simulateArmedIntent) {
      // Simulation path — no blockchain broadcast
      await simulateArmedIntent(supabase, intent).catch(err =>
        workerError('sim', 'Simulation error', {
          intent_id: intent.id,
          error: String(err?.message || err),
        }),
      )
    } else if (liveEnabled && executeIntent) {
      // Live execution path (LIVE_EXECUTION_ENABLED=true, safety switches on)
      await executeIntent(supabase, intent)
    } else if (liveEnabled) {
      // Legacy live fallback (lib not loaded)
      await legacyProcessIntent(supabase, intent)
    } else {
      // simMode=false, liveEnabled=false — should not reach here after early-return above
      workerLog('tick', 'Intent skipped: no execution path active', {
        intent_id: intent.id,
        live_enabled: liveEnabled,
        sim_mode: simMode,
      })
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const missing = envReady()
  if (missing.length) {
    workerWarn('boot', `Missing env: ${missing.join(', ')}. Worker booted safely but will not execute.`)
    if (RUN_ONCE) return
  }

  const supabase = missing.length ? null : supabaseClient()

  if (supabase && loadPersistedRpcHealth) {
    await loadPersistedRpcHealth(supabase).catch(() => null)
  }

  if (supabase && acquireLease && (FLAGS?.LEASE_ENABLED ?? false)) {
    const leaseResult = await acquireLease(supabase).catch(() => ({ acquired: true, workerId: 'unknown' }))
    if (!leaseResult.acquired) {
      workerWarn('boot', 'Worker lease conflict — another worker may be running', {
        conflicting_worker: leaseResult.conflictingWorker,
      })
    }
  }

  workerLog('boot', 'Strike worker started', {
    auto_strike: AUTO_STRIKE_ENABLED,
    alpha_vault: ALPHA_VAULT_ENABLED,
    live_execution:     FLAGS?.LIVE_EXECUTION_ENABLED     ?? false,
    simulation_mode:    FLAGS?.SIMULATION_MODE             ?? false,
    testnet_execution:  FLAGS?.TESTNET_EXECUTION_ENABLED   ?? false,
    retry_enabled: FLAGS?.RETRY_ENABLED ?? false,
    prewarm_enabled: FLAGS?.PREWARM_ENABLED ?? false,
    interval_ms: LOOP_MS,
    lib_loaded: Boolean(executeIntent),
    sim_executor_loaded: Boolean(simulateArmedIntent),
    heartbeat_interval: HEARTBEAT_INTERVAL,
  })

  while (!stopping) {
    try {
      if (supabase) await tick(supabase)
    } catch (error) {
      workerError('tick', 'Tick error', { error: String(error?.message || error) })
    }
    if (RUN_ONCE) break
    await sleep(LOOP_MS)
  }

  workerLog('boot', 'Strike worker stopped')
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
