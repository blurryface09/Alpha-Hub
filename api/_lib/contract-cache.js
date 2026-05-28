/**
 * Contract execution cache — in-memory with async Supabase persistence.
 *
 * Two cache layers:
 *   abiCache   — verified ABI per contract (1h TTL)
 *   execCache  — working function config per contract (24h TTL)
 *
 * Supabase persistence is fire-and-forget. If the mint_contract_cache table
 * doesn't exist, all Supabase ops silently no-op via .catch(() => null).
 */

const EXEC_TTL_MS  = 24 * 60 * 60 * 1000
const ABI_TTL_MS   =      60 * 60 * 1000
const PROBE_TTL_MS =      15 * 60 * 1000  // 15 min — probe state changes quickly

// Map<key, { abi, at }>
const abiCache  = new Map()
// Map<key, { functionName, argsSummary, gas, chainId, source, successCount, lastLatencyMs, at }>
const execCache = new Map()
// Map<key, { execution_status, revert_reason, function_tried, at }>
const probeCache = new Map()
// Map<key, number[]>  — rolling window of latency samples
const latencyMap = new Map()

const LATENCY_MAX = 10

function cacheKey(contract, chain) {
  return `${String(chain || 'eth').toLowerCase()}:${String(contract || '').toLowerCase()}`
}

// ─── ABI cache ────────────────────────────────────────────────────────────────

export function getCachedAbi(contract, chain) {
  const k = cacheKey(contract, chain)
  const entry = abiCache.get(k)
  if (!entry) return null
  if (Date.now() - entry.at > ABI_TTL_MS) { abiCache.delete(k); return null }
  return entry.abi
}

export function setCachedAbi(contract, chain, abi) {
  if (!abi) return
  abiCache.set(cacheKey(contract, chain), { abi, at: Date.now() })
}

// ─── Execution config cache ───────────────────────────────────────────────────

export function getCachedExecution(contract, chain) {
  const k = cacheKey(contract, chain)
  const entry = execCache.get(k)
  if (!entry) return null
  if (Date.now() - entry.at > EXEC_TTL_MS) { execCache.delete(k); return null }
  return entry
}

export function setCachedExecution(contract, chain, result, supabase = null) {
  const k = cacheKey(contract, chain)
  const prev = execCache.get(k)
  const entry = {
    functionName:  result.functionName,
    argsSummary:   result.argsSummary || [],
    gas:           result.gas,
    chainId:       result.chainId,
    source:        result.source,
    successCount:  (prev?.successCount || 0) + 1,
    lastLatencyMs: result.latencyMs || null,
    at:            Date.now(),
  }
  execCache.set(k, entry)

  if (supabase) {
    supabase.from('mint_contract_cache').upsert({
      contract_address: String(contract).toLowerCase(),
      chain:            String(chain).toLowerCase(),
      function_name:    result.functionName,
      args_summary:     result.argsSummary || [],
      gas_estimate:     result.gas,
      success_count:    entry.successCount,
      last_latency_ms:  result.latencyMs || null,
      last_success_at:  new Date().toISOString(),
    }, { onConflict: 'contract_address,chain' }).then(r => r, () => null)
  }
}

export async function loadCachedExecution(contract, chain, supabase) {
  const cached = getCachedExecution(contract, chain)
  if (cached) return cached
  if (!supabase) return null
  try {
    const { data } = await supabase
      .from('mint_contract_cache')
      .select('function_name, args_summary, gas_estimate, success_count, last_latency_ms, last_success_at')
      .eq('contract_address', String(contract).toLowerCase())
      .eq('chain', String(chain).toLowerCase())
      .maybeSingle()
    if (!data) return null
    const entry = {
      functionName:  data.function_name,
      argsSummary:   data.args_summary || [],
      gas:           data.gas_estimate,
      chainId:       null,
      source:        'db_cache',
      successCount:  data.success_count || 1,
      lastLatencyMs: data.last_latency_ms,
      // Fallback to now if last_success_at is missing — avoids instant expiry on new Date(null)
      at:            data.last_success_at ? new Date(data.last_success_at).getTime() : Date.now(),
    }
    execCache.set(cacheKey(contract, chain), entry)
    return entry
  } catch {
    return null
  }
}

// ─── Execution latency history ────────────────────────────────────────────────

export function recordLatency(contract, chain, latencyMs) {
  const k = cacheKey(contract, chain)
  if (!latencyMap.has(k)) latencyMap.set(k, [])
  const history = latencyMap.get(k)
  history.push(latencyMs)
  if (history.length > LATENCY_MAX) history.shift()
}

export function getLatencyHistory(contract, chain) {
  return latencyMap.get(cacheKey(contract, chain)) || []
}

export function getAvgLatency(contract, chain) {
  const history = getLatencyHistory(contract, chain)
  if (!history.length) return null
  return Math.round(history.reduce((a, b) => a + b, 0) / history.length)
}

// ─── Confidence score (0-100) ─────────────────────────────────────────────────

export function getExecutionConfidence(contract, chain) {
  const exec = execCache.get(cacheKey(contract, chain))
  const abi  = abiCache.get(cacheKey(contract, chain))
  let score = 0
  if (exec) {
    score += 55
    if (exec.successCount >= 2) score += 15
    if (exec.source === 'verified_abi') score += 15
    else if (exec.source === 'db_cache') score += 5
    if (exec.lastLatencyMs && exec.lastLatencyMs < 500) score += 10
  } else if (abi) {
    score += 20
  }
  return Math.min(100, score)
}

export function isStaleCached(contract, chain) {
  const entry = execCache.get(cacheKey(contract, chain))
  if (!entry) return false
  return (Date.now() - entry.at) >= 6 * 60 * 60 * 1000
}

export function invalidateCachedExecution(contract, chain) {
  execCache.delete(cacheKey(contract, chain))
}

// ─── Live probe result cache ──────────────────────────────────────────────────

export function getCachedProbeResult(contract, chain) {
  const k = cacheKey(contract, chain)
  const entry = probeCache.get(k)
  if (!entry) return null
  if (Date.now() - entry.at > PROBE_TTL_MS) { probeCache.delete(k); return null }
  return entry
}

export function setCachedProbeResult(contract, chain, result) {
  if (!contract || !chain || !result) return
  probeCache.set(cacheKey(contract, chain), { ...result, at: Date.now() })
}

export function getPrewarmStatus(contract, chain) {
  const exec       = contract ? execCache.get(cacheKey(contract, chain)) : null
  const confidence = getExecutionConfidence(contract, chain)
  const avgLatency = getAvgLatency(contract, chain)
  return {
    ready:         Boolean(exec),
    confidence,
    functionName:  exec?.functionName || null,
    successCount:  exec?.successCount || 0,
    lastLatencyMs: exec?.lastLatencyMs || null,
    avgLatencyMs:  avgLatency,
    cachedAt:      exec ? new Date(exec.at).toISOString() : null,
  }
}
