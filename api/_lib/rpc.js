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
  const raw = error?.shortMessage || error?.message || String(error || '')
  const msg = raw.toLowerCase()
  if (msg.includes('insufficient funds') || msg.includes('total cost') || msg.includes('exceeds the balance') || msg.includes('exceeds balance')) {
    return 'Insufficient ETH — top up the vault wallet and try again.'
  }
  if (msg.includes('seadrop mint not active') || msg.includes('public drop not configured') || msg.includes('not currently active')) {
    return 'Mint is not currently active — the public drop is not open yet.'
  }
  if (msg.includes('sale not active') || msg.includes('sale is not active') || msg.includes('not started') || msg.includes('not open') || msg.includes('mint closed') || msg.includes('mint has not') || msg.includes('minting is not') || msg.includes('paused')) {
    return 'Mint is not open yet or has ended. Check the official mint page for the correct time.'
  }
  if (msg.includes('allowlist') || msg.includes('not whitelisted') || msg.includes('not eligible') || msg.includes('merkle') || msg.includes('not in whitelist')) {
    return 'Vault wallet is not on the allowlist for this mint phase.'
  }
  if (msg.includes('already minted') || msg.includes('max per wallet') || msg.includes('max mint') || msg.includes('limit reached') || msg.includes('max tokens') || msg.includes('token limit')) {
    return 'Max mints reached — this wallet has already hit the limit for this mint.'
  }
  if (msg.includes('max supply') || msg.includes('sold out') || msg.includes('exceeds max') || msg.includes('supply exceeded')) {
    return 'Sold out — this mint has reached maximum supply.'
  }
  if (msg.includes('no contract exists') || msg.includes('no bytecode') || msg.includes('contract not found')) {
    return 'No contract found at this address on the selected chain.'
  }
  if (msg.includes('msg.value') || msg.includes('wrong value') || msg.includes('incorrect value') || msg.includes('invalid price')) {
    return 'Wrong mint price sent. Check the price on the official mint page.'
  }
  if (msg.includes('nonce')) {
    return 'Transaction nonce error — reset vault wallet pending transactions.'
  }
  if (msg.includes('execution reverted') || msg.includes('revert')) {
    return 'Mint simulation failed — contract rejected the transaction. The mint may be closed or require an allowlist.'
  }
  if (msg.includes('rpc') || msg.includes('http request failed') || msg.includes('fetch failed') || msg.includes('network error') || msg.includes('econnrefused') || msg.includes('etimedout')) {
    return 'RPC connection failed. Will retry on next tick.'
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return 'Request timed out. Will retry on next tick.'
  }
  if (msg.includes('unsupported mint function') || msg.includes('no supported mint') || msg.includes('no standard mint')) {
    return 'Could not detect the mint function. Verify contract address and add contract details.'
  }
  if (msg.includes('chain') || msg.includes('network')) {
    return 'Wrong chain — check the project chain setting.'
  }
  return `Automint failed: ${raw.slice(0, 120)}`
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
