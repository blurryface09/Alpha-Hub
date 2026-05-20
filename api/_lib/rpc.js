import { custom } from 'viem'

const DEFAULT_TIMEOUT_MS = 12000

const CHAIN_RPC_ENV = {
  eth:  ['ETH_RPC_URL', 'ETH_RPC_URL_FALLBACK_1', 'ETH_RPC_URL_FALLBACK_2'],
  base: ['BASE_RPC_URL', 'BASE_RPC_URL_FALLBACK_1', 'BASE_RPC_URL_FALLBACK_2'],
  bnb:  ['BNB_RPC_URL', 'BNB_RPC_URL_FALLBACK_1', 'BNB_RPC_URL_FALLBACK_2'],
}

const PUBLIC_FALLBACKS = {
  eth:  ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
  bnb:  ['https://bsc-dataseed.binance.org'],
}

// ─── Health scoring (EMA per RPC URL) ────────────────────────────────────────

const healthMap = new Map()
const EMA_ALPHA = 0.3
const FAIL_DEPRIORITISE = 3

function getHealth(url) {
  if (!healthMap.has(url)) healthMap.set(url, { latencyEma: 500, failCount: 0 })
  return healthMap.get(url)
}

function recordSuccess(url, latencyMs) {
  const h = getHealth(url)
  h.latencyEma = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * h.latencyEma
  h.failCount = 0
}

function recordFailure(url) {
  getHealth(url).failCount += 1
}

function fallbackAlchemyUrl(chainKey) {
  const key = process.env.ALCHEMY_API_KEY || process.env.VITE_ALCHEMY_API_KEY
  if (!key) return null
  if (chainKey === 'base') return `https://base-mainnet.g.alchemy.com/v2/${key}`
  if (chainKey === 'bnb')  return `https://bnb-mainnet.g.alchemy.com/v2/${key}`
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`
}

export function rpcUrls(chainKey = 'eth') {
  const envKeys = CHAIN_RPC_ENV[chainKey] || CHAIN_RPC_ENV.eth
  const envUrls = envKeys.map(k => process.env[k]).filter(Boolean)
  const alchemy = fallbackAlchemyUrl(chainKey)
  const fallbacks = PUBLIC_FALLBACKS[chainKey] || PUBLIC_FALLBACKS.eth
  const all = [...new Set([...envUrls, ...(alchemy ? [alchemy] : []), ...fallbacks])]

  // Sort: healthy providers first (by EMA latency), degraded last
  const healthy  = all.filter(u => getHealth(u).failCount < FAIL_DEPRIORITISE)
  const degraded = all.filter(u => getHealth(u).failCount >= FAIL_DEPRIORITISE)
  healthy.sort((a, b) => getHealth(a).latencyEma - getHealth(b).latencyEma)
  return [...healthy, ...degraded]
}

export function getRpcHealth() {
  return Array.from(healthMap.entries()).map(([url, h]) => ({
    url,
    latency_ema_ms: Math.round(h.latencyEma),
    fail_count: h.failCount,
    degraded: h.failCount >= FAIL_DEPRIORITISE,
  }))
}

export function sanitizeRpcError(error) {
  const message = error?.shortMessage || error?.message || String(error || '')
  if (message.toLowerCase().includes('revert')) return 'Mint simulation failed. Transaction was not sent.'
  if (message.toLowerCase().includes('timeout')) return 'Automint is temporarily unavailable.'
  return 'Automint is temporarily unavailable.'
}

export async function rpcRequest(chainKey, method, params = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
  const urls = rpcUrls(chainKey)
  if (!urls.length) throw new Error(`No RPC configured for ${chainKey}`)

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
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.error) throw new Error(body?.error?.message || `RPC ${response.status}`)
      const latencyMs = Date.now() - started
      recordSuccess(url, latencyMs)
      console.log(`rpc ${index === 0 ? 'primary' : `fallback_${index}`} succeeded`, { chain: chainKey, method, latencyMs })
      clearTimeout(timer)
      return { result: body.result, rpcUrl: url, rpcIndex: index, latencyMs }
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      recordFailure(url)
      console.error('rpc attempt failed', { chain: chainKey, method, rpcIndex: index, error: error.message })
    }
  }

  throw lastError || new Error('RPC request failed')
}

export function fallbackTransport(chainKey) {
  return custom({
    request: async ({ method, params }) => {
      const { result } = await rpcRequest(chainKey, method, params || [])
      return result
    },
  })
}
