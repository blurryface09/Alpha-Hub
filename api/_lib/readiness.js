/**
 * Execution readiness scoring — pure in-memory, never throws.
 *
 * Aggregates cache state + RPC health into a single readiness object.
 * All five checks draw from in-memory Maps so there are no network calls.
 * The API handler triggers background prewarm when stale or unready.
 *
 * Score  Status
 * ≥ 75   execution_ready
 * ≥ 40   partial
 *  < 40  not_ready
 */

import { getCachedAbi, getCachedExecution, getCachedProbeResult, getAvgLatency } from './contract-cache.js'
import { getRpcHealth } from './rpc.js'

export const READINESS_STATUS = {
  EXECUTION_READY: 'execution_ready',
  PARTIAL:         'partial',
  NOT_READY:       'not_ready',
}

// Weights (sum = 100)
const W = {
  contract_valid:  20,
  rpc_healthy:     15,
  abi_known:       15,
  function_cached: 40,
  cache_fresh:     10,
}

const STALE_MS = 6 * 60 * 60 * 1000  // 6h — flag before 24h TTL

/**
 * Compute execution readiness for a contract/chain pair.
 *
 * @param {string|null} contract
 * @param {string} chain
 * @returns {ReadinessResult}
 */
export function computeReadiness(contract, chain) {
  const checks   = {}
  let score      = 0
  const blockers = []
  const warnings = []

  // ── 1. Contract address ──────────────────────────────────────────────────────
  const contractOk = Boolean(
    contract &&
    contract !== '0x0000000000000000000000000000000000000000' &&
    /^0x[0-9a-fA-F]{40}$/.test(contract),
  )
  checks.contract_valid = {
    pass:   contractOk,
    label:  'Contract address',
    detail: contractOk ? `${String(contract).slice(0, 10)}…` : 'Missing or invalid',
  }
  if (contractOk) score += W.contract_valid
  else blockers.push('No valid contract address')

  // ── 2. RPC health ────────────────────────────────────────────────────────────
  const rpcHealth   = getRpcHealth()
  const hasRpcData  = rpcHealth.length > 0
  const healthyRpcs = rpcHealth.filter(h => !h.degraded)
  const allDegraded = hasRpcData && healthyRpcs.length === 0
  const rpcPass     = !allDegraded
  const bestRpc     = [...healthyRpcs].sort((a, b) => a.latency_ema_ms - b.latency_ema_ms)[0]
  checks.rpc_healthy = {
    pass:   rpcPass,
    label:  'RPC health',
    detail: hasRpcData
      ? rpcPass
        ? bestRpc ? `Best ${bestRpc.latency_ema_ms}ms` : `${healthyRpcs.length} healthy`
        : 'All RPCs degraded'
      : 'Not yet measured',
  }
  if (rpcPass) score += W.rpc_healthy
  if (allDegraded) warnings.push('All RPCs degraded — execution quality reduced')

  // ── 3. ABI cached ────────────────────────────────────────────────────────────
  const abi = contractOk ? getCachedAbi(contract, chain) : null
  checks.abi_known = {
    pass:   Boolean(abi),
    label:  'ABI',
    detail: abi ? `${abi.length} functions` : 'Not cached',
  }
  if (abi) score += W.abi_known

  // ── 4. Mint function detected ─────────────────────────────────────────────────
  const exec = contractOk ? getCachedExecution(contract, chain) : null
  checks.function_cached = {
    pass:   Boolean(exec),
    label:  'Mint function',
    detail: exec
      ? `${exec.functionName} (${exec.successCount}× proven, ~${Number(exec.gas || 0).toLocaleString()} gas)`
      : 'Not detected — prewarm will resolve',
  }
  if (exec) score += W.function_cached
  else warnings.push('Mint function not detected — prewarm queued')

  // ── 5. Cache freshness ───────────────────────────────────────────────────────
  const cacheAgeMs  = exec ? Date.now() - exec.at : null
  const staleCache  = exec ? cacheAgeMs >= STALE_MS : false
  const cacheFresh  = exec && !staleCache
  checks.cache_fresh = {
    pass:   cacheFresh,
    label:  'Cache freshness',
    detail: exec
      ? cacheFresh
        ? `${Math.round(cacheAgeMs / 60000)}min ago`
        : `Stale — ${Math.round(cacheAgeMs / 3600000)}h old`
      : 'No cache',
  }
  if (cacheFresh) score += W.cache_fresh
  if (staleCache) warnings.push('Execution cache stale — auto-refresh triggered')

  // ── 6. Live probe state (informational — no score contribution) ──────────────
  // Probe cache has 15min TTL. A negative state means the last gas simulation failed
  // for a known reason — surface it as a warning so the UI can show it.
  const PROBE_NEGATIVE = new Set(['not_started', 'paused', 'sold_out', 'allowlist_only',
    'unsupported_execution', 'wrong_function', 'proof_unavailable', 'wallet_not_eligible'])
  const probe = contractOk ? getCachedProbeResult(contract, chain) : null
  const probeNegative = probe && PROBE_NEGATIVE.has(probe.execution_status)
  checks.probe_state = {
    pass:   !probeNegative,
    label:  'Contract state',
    detail: probe ? probe.execution_status : 'Not probed',
  }
  if (probeNegative) warnings.push(`Contract state: ${probe.execution_status}`)

  score = Math.min(100, Math.max(0, score))
  const status = score >= 75
    ? READINESS_STATUS.EXECUTION_READY
    : score >= 40
      ? READINESS_STATUS.PARTIAL
      : READINESS_STATUS.NOT_READY

  console.log('[execution-ready] readiness_computed', {
    contract:    contract?.slice(0, 10),
    chain,
    score,
    status,
    fn:          exec?.functionName || null,
    stale:       staleCache,
    probe_state: probe?.execution_status || null,
    rpc:         { total: rpcHealth.length, healthy: healthyRpcs.length },
  })

  return {
    ready:         status === READINESS_STATUS.EXECUTION_READY,
    score,
    status,
    checks,
    blockers,
    warnings,
    staleCache,
    probeState:    probe?.execution_status || null,
    functionName:  exec?.functionName  || null,
    gasEstimate:   exec?.gas           || null,
    successCount:  exec?.successCount  || 0,
    lastLatencyMs: exec?.lastLatencyMs || null,
    avgLatencyMs:  getAvgLatency(contract, chain),
    rpcCount:      { total: rpcHealth.length, healthy: healthyRpcs.length },
  }
}
