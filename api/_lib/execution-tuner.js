/**
 * Autonomous execution tuning.
 *
 * Learns from every mint attempt within a process lifetime:
 *   - Gas ranges per contract (rolling p95 → recommended gas limit)
 *   - Confirmation times per chain (dynamic timeout scaling)
 *   - RPC performance per URL (latency EMA, fail rate)
 *   - Retry pattern success rates per error type
 *   - Execution history per contract (rolling 50 records)
 *
 * All state is in-memory. The worker (long-running) accumulates the richest
 * data. API functions get ephemeral data that resets per cold start.
 *
 * Emits [execution-optimize] telemetry after every recordMintResult call.
 */

const GAS_WINDOW     = 20   // rolling gas readings per contract
const CONFIRM_WINDOW = 10   // rolling confirmation times per chain
const HISTORY_CAP    = 50   // max execution records per contract
const MIN_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_MS = 30_000

// Map<contractKey, number[]>
const gasReadings = new Map()

// Map<chain, Map<url, { success, fail, latencySum, count }>>
const rpcStats = new Map()

// Map<chain, number[]>
const confirmReadings = new Map()

// Map<contractKey, Map<errorType, { attempts, successes }>>
const retryStats = new Map()

// Map<contractKey, { success, fail, records[] }>
const execHistory = new Map()

function contractKey(contract, chain) {
  return `${String(chain || 'eth').toLowerCase()}:${String(contract || '').toLowerCase()}`
}

function normaliseChain(chain) {
  return String(chain || 'eth').toLowerCase()
}

// ── Gas profile ───────────────────────────────────────────────────────────────

/**
 * Record a single execution result for tuning.
 *
 * @param {string} contract
 * @param {string} chain
 * @param {object} result
 * @param {boolean}      result.success
 * @param {string|null}  result.gasLimit       — gas limit sent with tx
 * @param {string|null}  result.gasUsed        — actual gas consumed (if known)
 * @param {number|null}  result.latencyMs      — ms from execution start to tx sent
 * @param {number|null}  result.confirmationMs — ms from tx sent to confirmed
 * @param {string|null}  result.rpcUrl         — RPC URL used
 * @param {string|null}  result.functionName   — mint function called
 * @param {string|null}  result.errorType      — error classification (if failed)
 * @param {boolean}      [result.retrySucceeded] — did a retry recover the attempt?
 */
export function recordMintResult(contract, chain, result = {}) {
  if (!contract) return
  const key   = contractKey(contract, chain)
  const cKey  = normaliseChain(chain)
  const {
    success,
    gasLimit,
    gasUsed,
    latencyMs,
    confirmationMs,
    rpcUrl,
    functionName,
    errorType,
    retrySucceeded = false,
  } = result

  // ── Gas readings ────────────────────────────────────────────────────────────
  const gasVal = Number(gasUsed || gasLimit || 0)
  if (gasVal > 0 && success) {  // only learn from successful executions
    if (!gasReadings.has(key)) gasReadings.set(key, [])
    const arr = gasReadings.get(key)
    arr.push(gasVal)
    if (arr.length > GAS_WINDOW) arr.shift()
  }

  // ── RPC performance ─────────────────────────────────────────────────────────
  if (rpcUrl) {
    if (!rpcStats.has(cKey)) rpcStats.set(cKey, new Map())
    const chainMap = rpcStats.get(cKey)
    if (!chainMap.has(rpcUrl)) chainMap.set(rpcUrl, { success: 0, fail: 0, latencySum: 0, count: 0 })
    const stat = chainMap.get(rpcUrl)
    if (success) {
      stat.success++
      if (latencyMs) { stat.latencySum += latencyMs; stat.count++ }
    } else {
      stat.fail++
    }
  }

  // ── Confirmation timing ─────────────────────────────────────────────────────
  if (success && confirmationMs && confirmationMs > 0) {
    if (!confirmReadings.has(cKey)) confirmReadings.set(cKey, [])
    const arr = confirmReadings.get(cKey)
    arr.push(confirmationMs)
    if (arr.length > CONFIRM_WINDOW) arr.shift()
  }

  // ── Retry pattern ───────────────────────────────────────────────────────────
  if (errorType) {
    if (!retryStats.has(key)) retryStats.set(key, new Map())
    const profile = retryStats.get(key)
    if (!profile.has(errorType)) profile.set(errorType, { attempts: 0, successes: 0 })
    const stat = profile.get(errorType)
    stat.attempts++
    if (retrySucceeded) stat.successes++
  }

  // ── Execution history ───────────────────────────────────────────────────────
  if (!execHistory.has(key)) execHistory.set(key, { success: 0, fail: 0, records: [] })
  const hist = execHistory.get(key)
  if (success) hist.success++
  else hist.fail++
  hist.records.push({
    success:      Boolean(success),
    gasLimit:     gasLimit  || null,
    gasUsed:      gasUsed   || null,
    latencyMs:    latencyMs || null,
    rpcUrl:       rpcUrl    || null,
    functionName: functionName || null,
    errorType:    errorType || null,
    at:           Date.now(),
  })
  if (hist.records.length > HISTORY_CAP) hist.records.shift()

  // ── [execution-optimize] telemetry ─────────────────────────────────────────
  const gasProf   = getGasProfile(contract, chain)
  const chainProf = getChainProfile(chain)
  const total     = hist.success + hist.fail
  console.log('[execution-optimize] result_recorded', {
    contract:    contract.slice(0, 10),
    chain,
    success,
    gasLimit,
    gasUsed,
    latencyMs,
    avgLatency:  chainProf.avgLatencyMs,
    successRate: total > 0 ? Math.round((hist.success / total) * 100) : null,
    bestRpc:     chainProf.bestRpc ? chainProf.bestRpc.replace(/^https?:\/\//, '').slice(0, 30) : null,
    gasProfile:  gasProf ? { min: gasProf.min, max: gasProf.max, p95: gasProf.p95, recommended: gasProf.recommended } : null,
    fn:          functionName || null,
    errorType:   errorType   || null,
    optimized:   isOptimized(contract, chain),
  })
}

// ── Gas profile ───────────────────────────────────────────────────────────────

/**
 * Get rolling gas usage statistics for a contract.
 * Only populated after successful live executions.
 *
 * @param {string} contract
 * @param {string} chain
 * @returns {{ min, max, avg, p95, recommended, readings } | null}
 */
export function getGasProfile(contract, chain) {
  const key = contractKey(contract, chain)
  const arr = gasReadings.get(key)
  if (!arr || !arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const avg    = Math.round(arr.reduce((s, n) => s + n, 0) / arr.length)
  const p95idx = Math.max(0, Math.floor(sorted.length * 0.95))
  const p95    = sorted[p95idx] ?? sorted[sorted.length - 1]
  return {
    min:         sorted[0],
    max:         sorted[sorted.length - 1],
    avg,
    p95,
    recommended: Math.round(p95 * 1.1),  // 10% headroom above p95
    readings:    arr.length,
  }
}

// ── RPC best URL ──────────────────────────────────────────────────────────────

/**
 * Return the RPC URL with the best performance (lowest latency, lowest fail rate).
 * Returns null when no data is available.
 *
 * @param {string} chain
 * @returns {string|null}
 */
export function getBestRpc(chain) {
  const cKey = normaliseChain(chain)
  const chainMap = rpcStats.get(cKey)
  if (!chainMap || !chainMap.size) return null
  let bestUrl   = null
  let bestScore = Infinity
  for (const [url, stat] of chainMap) {
    const total = stat.success + stat.fail
    if (total === 0) continue
    const failRate   = stat.fail / total
    if (failRate > 0.5) continue  // skip if >50% fail rate
    const avgLatency = stat.count > 0 ? stat.latencySum / stat.count : 999_999
    const score      = avgLatency * (1 + failRate * 2)
    if (score < bestScore) { bestScore = score; bestUrl = url }
  }
  return bestUrl
}

// ── Chain profile ─────────────────────────────────────────────────────────────

/**
 * Get chain-level execution profile.
 *
 * @param {string} chain
 * @returns {{ avgConfirmationMs: number|null, timeoutMs: number, bestRpc: string|null, avgLatencyMs: number|null }}
 */
export function getChainProfile(chain) {
  const cKey = normaliseChain(chain)
  const readings = confirmReadings.get(cKey) || []
  const avgConfirmationMs = readings.length
    ? Math.round(readings.reduce((s, n) => s + n, 0) / readings.length)
    : null

  // Dynamic timeout: 2× avg confirmation, clamped
  const timeoutMs = avgConfirmationMs
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, avgConfirmationMs * 2))
    : DEFAULT_TIMEOUT_MS

  const bestRpc = getBestRpc(chain)

  // Avg latency across all known RPCs for this chain
  const chainMap = rpcStats.get(cKey)
  let totalLatency = 0, totalCount = 0
  if (chainMap) {
    for (const s of chainMap.values()) { totalLatency += s.latencySum; totalCount += s.count }
  }
  const avgLatencyMs = totalCount > 0 ? Math.round(totalLatency / totalCount) : null

  return { avgConfirmationMs, timeoutMs, bestRpc, avgLatencyMs }
}

// ── Retry profile ─────────────────────────────────────────────────────────────

/**
 * Get retry pattern statistics for a contract.
 *
 * @param {string} contract
 * @param {string} chain
 * @returns {{ errorTypes: object, recommendation: string }}
 */
export function getRetryProfile(contract, chain) {
  const key = contractKey(contract, chain)
  const profile = retryStats.get(key)
  if (!profile || !profile.size) return { errorTypes: {}, recommendation: 'default' }
  const errorTypes = {}
  let anyRetryHelps = false
  for (const [type, stat] of profile) {
    const rate = stat.attempts > 0 ? Math.round((stat.successes / stat.attempts) * 100) : 0
    errorTypes[type] = { attempts: stat.attempts, successes: stat.successes, rate }
    if (rate > 50 && type !== 'revert') anyRetryHelps = true
  }
  return { errorTypes, recommendation: anyRetryHelps ? 'retry' : 'default' }
}

// ── Optimized status ──────────────────────────────────────────────────────────

/**
 * Returns true when this contract has ≥2 successful live executions in this process.
 *
 * @param {string} contract
 * @param {string} chain
 * @returns {boolean}
 */
export function isOptimized(contract, chain) {
  const hist = execHistory.get(contractKey(contract, chain))
  return Boolean(hist && hist.success >= 2)
}

// ── Full execution profile ────────────────────────────────────────────────────

/**
 * Return the complete in-process execution profile for a contract.
 *
 * @param {string} contract
 * @param {string} chain
 * @returns {object}
 */
export function getExecutionProfile(contract, chain) {
  const key  = contractKey(contract, chain)
  const hist = execHistory.get(key)
  const gas  = getGasProfile(contract, chain)
  const cp   = getChainProfile(chain)
  const rp   = getRetryProfile(contract, chain)
  const total = (hist?.success ?? 0) + (hist?.fail ?? 0)
  return {
    contract,
    chain,
    optimized:    isOptimized(contract, chain),
    successCount: hist?.success  ?? 0,
    failCount:    hist?.fail     ?? 0,
    successRate:  total > 0 ? Math.round((hist.success / total) * 100) : null,
    gasProfile:   gas,
    chainProfile: cp,
    retryProfile: rp,
    recentHistory: hist?.records.slice(-10) || [],
  }
}

// ── Optimized execution params ────────────────────────────────────────────────

/**
 * Compute tuned execution params for a contract, improving on the base estimate.
 *
 * @param {string}      contract
 * @param {string}      chain
 * @param {string|number|null} baseGas  — gas estimate from prepareMintTransaction
 * @returns {{ gas: number|undefined, timeoutMs: number, bestRpc: string|null }}
 */
export function computeOptimizedParams(contract, chain, baseGas = null) {
  const gas = getGasProfile(contract, chain)
  const cp  = getChainProfile(chain)

  // Use the higher of: base estimate OR p95-based recommendation
  const baseNum = Number(baseGas || 0)
  const recommended = gas?.recommended ?? 0
  const finalGas = Math.max(baseNum, recommended) || undefined

  return {
    gas:       finalGas,
    timeoutMs: cp.timeoutMs,
    bestRpc:   cp.bestRpc,
  }
}

// ── RPC stats snapshot ────────────────────────────────────────────────────────

/**
 * Return a snapshot of all tracked RPC statistics.
 * Useful for telemetry and debugging.
 *
 * @returns {object[]}
 */
export function getRpcStats() {
  const result = []
  for (const [chain, chainMap] of rpcStats) {
    for (const [url, stat] of chainMap) {
      const total = stat.success + stat.fail
      result.push({
        chain,
        url,
        success:    stat.success,
        fail:       stat.fail,
        failRate:   total > 0 ? Math.round((stat.fail / total) * 100) : 0,
        avgLatency: stat.count > 0 ? Math.round(stat.latencySum / stat.count) : null,
      })
    }
  }
  return result
}
