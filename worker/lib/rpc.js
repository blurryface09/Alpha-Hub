/**
 * RPC abstraction with latency scoring and automatic failover.
 * Maintains an EMA latency score per URL and deprioritises failing providers.
 */

import { custom } from 'viem'
import { log as globalLog } from './logger.js'

// ─── Chain configuration ──────────────────────────────────────────────────────

const CHAIN_RPC_ENV = {
  eth: ['ETH_RPC_URL', 'ETH_RPC_URL_FALLBACK_1', 'ETH_RPC_URL_FALLBACK_2'],
  base: ['BASE_RPC_URL', 'BASE_RPC_URL_FALLBACK_1', 'BASE_RPC_URL_FALLBACK_2'],
  bnb: ['BNB_RPC_URL', 'BNB_RPC_URL_FALLBACK_1', 'BNB_RPC_URL_FALLBACK_2'],
  apechain: ['APECHAIN_RPC_URL'],
}

const PUBLIC_FALLBACKS = {
  eth: [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.llamarpc.com',
  ],
  bnb: [
    'https://bsc-dataseed.binance.org',
  ],
  apechain: [],
}

// ─── Health scoring ───────────────────────────────────────────────────────────

/**
 * Health state per RPC URL.
 * @type {Map<string, { latencyEma: number, failCount: number, lastCheck: number }>}
 */
const healthMap = new Map()

const EMA_ALPHA = 0.3
const FAIL_DEPRIORITISE_THRESHOLD = 3

function getHealth(url) {
  if (!healthMap.has(url)) {
    healthMap.set(url, { latencyEma: 500, failCount: 0, lastCheck: 0 })
  }
  return healthMap.get(url)
}

function recordSuccess(url, latencyMs) {
  const h = getHealth(url)
  h.latencyEma = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * h.latencyEma
  h.failCount = 0
  h.lastCheck = Date.now()
}

function recordFailure(url) {
  const h = getHealth(url)
  h.failCount += 1
  h.lastCheck = Date.now()
}

/**
 * Return ordered list of URLs for a chain, healthy providers first.
 * @param {string} chain
 * @returns {string[]}
 */
export function getRpcUrls(chain) {
  const normalised = String(chain || 'eth').toLowerCase()
  const envKeys = CHAIN_RPC_ENV[normalised] || CHAIN_RPC_ENV.eth
  const envUrls = envKeys.map(k => process.env[k]).filter(Boolean)
  const fallbacks = PUBLIC_FALLBACKS[normalised] || PUBLIC_FALLBACKS.eth
  const all = [...new Set([...envUrls, ...fallbacks])]

  // Sort: healthy (failCount < threshold) before degraded; within each group sort by EMA latency
  const healthy = all.filter(u => getHealth(u).failCount < FAIL_DEPRIORITISE_THRESHOLD)
  const degraded = all.filter(u => getHealth(u).failCount >= FAIL_DEPRIORITISE_THRESHOLD)

  healthy.sort((a, b) => getHealth(a).latencyEma - getHealth(b).latencyEma)
  degraded.sort((a, b) => getHealth(a).latencyEma - getHealth(b).latencyEma)

  return [...healthy, ...degraded]
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

/**
 * Send a JSON-RPC request to the best available provider for a chain,
 * falling back to the next on failure.
 *
 * @param {string} chain
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} timeoutMs
 * @returns {Promise<{ result: unknown, rpcUrl: string, latencyMs: number, rpcIndex: number }>}
 */
export async function rpcFetch(chain, method, params = [], timeoutMs = 8000) {
  const urls = getRpcUrls(chain)
  if (!urls.length) throw new Error(`No RPC configured for chain: ${chain}`)

  let lastError
  for (const [index, url] of urls.entries()) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.error) {
        throw new Error(body?.error?.message || `HTTP ${response.status}`)
      }
      const latencyMs = Date.now() - started
      recordSuccess(url, latencyMs)
      globalLog.debug('tick', `rpc success`, {
        chain,
        method,
        rpc_url: url,
        rpc_index: index,
        latency_ms: latencyMs,
      })
      clearTimeout(timer)
      return { result: body.result, rpcUrl: url, latencyMs, rpcIndex: index }
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      recordFailure(url)
      globalLog.warn('tick', `rpc attempt failed`, {
        chain,
        method,
        rpc_url: url,
        rpc_index: index,
        error: error.message,
      })
    }
  }

  throw lastError || new Error(`All RPC providers failed for chain: ${chain}`)
}

// ─── Viem transport ───────────────────────────────────────────────────────────

/**
 * Build a viem `custom` transport that uses rpcFetch with failover.
 * @param {string} chain
 * @returns {import('viem').Transport}
 */
export function createViemTransport(chain) {
  return custom({
    async request({ method, params }) {
      const { result } = await rpcFetch(chain, method, params || [])
      return result
    },
  })
}

// ─── Health snapshot ──────────────────────────────────────────────────────────

/**
 * Return the current health snapshot for all known RPC providers.
 * @returns {Array<{ url: string, latency_ema_ms: number, fail_count: number, last_check: string|null, degraded: boolean }>}
 */
export function getRpcHealth() {
  return Array.from(healthMap.entries()).map(([url, h]) => ({
    url,
    latency_ema_ms: Math.round(h.latencyEma),
    fail_count:     h.failCount,
    last_check:     h.lastCheck ? new Date(h.lastCheck).toISOString() : null,
    degraded:       h.failCount >= FAIL_DEPRIORITISE_THRESHOLD,
  }))
}

/**
 * Export the health map as a plain JSON-serializable object for persistence.
 * @returns {Record<string, { latencyEma: number, failCount: number, lastCheck: number }>}
 */
export function exportHealthSnapshot() {
  const out = {}
  for (const [url, h] of healthMap.entries()) {
    out[url] = { latencyEma: h.latencyEma, failCount: h.failCount, lastCheck: h.lastCheck }
  }
  return out
}

/**
 * Restore the health map from a previously exported snapshot.
 * Only restores entries whose lastCheck is within 1 hour (stale snapshots are ignored).
 *
 * @param {Record<string, { latencyEma: number, failCount: number, lastCheck: number }>} snapshot
 */
export function importHealthSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  const cutoff = Date.now() - 3_600_000 // ignore entries older than 1h
  for (const [url, h] of Object.entries(snapshot)) {
    if (h.lastCheck && h.lastCheck < cutoff) continue
    healthMap.set(url, {
      latencyEma: Number(h.latencyEma) || 500,
      failCount:  Number(h.failCount)  || 0,
      lastCheck:  Number(h.lastCheck)  || 0,
    })
  }
}

/**
 * Persist current RPC health to the DB as an execution event.
 * Uses a fixed sentinel intent_id so it can be queried later.
 * Silently no-ops if the DB call fails (health data is advisory).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function persistRpcHealth(supabase) {
  if (!supabase) return
  const snapshot = exportHealthSnapshot()
  const entries  = Object.keys(snapshot).length
  if (!entries) return

  await supabase.from('mint_execution_events').insert({
    intent_id: null,
    user_id:   null,
    state:     'rpc_health_snapshot',
    message:   `RPC health snapshot: ${entries} providers`,
    metadata:  snapshot,
  }).catch(() => null) // always advisory
}

/**
 * Load the most recent RPC health snapshot from the DB and restore it.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function loadPersistedRpcHealth(supabase) {
  if (!supabase) return
  try {
    const { data } = await supabase
      .from('mint_execution_events')
      .select('metadata, created_at')
      .eq('state', 'rpc_health_snapshot')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (data?.metadata) {
      importHealthSnapshot(data.metadata)
      globalLog.info('tick', 'Restored RPC health snapshot from DB', {
        providers: Object.keys(data.metadata).length,
        snapshot_age_s: Math.round((Date.now() - new Date(data.created_at).getTime()) / 1000),
      })
    }
  } catch { /* table may not have null intent_id rows — ignore */ }
}
