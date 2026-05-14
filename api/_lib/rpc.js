import { custom } from 'viem'

const DEFAULT_TIMEOUT_MS = 12000

const CHAIN_RPC_ENV = {
  eth: ['ETH_RPC_URL', 'ETH_RPC_URL_FALLBACK_1', 'ETH_RPC_URL_FALLBACK_2'],
  base: ['BASE_RPC_URL', 'BASE_RPC_URL_FALLBACK_1', 'BASE_RPC_URL_FALLBACK_2'],
  bnb: ['BNB_RPC_URL', 'BNB_RPC_URL_FALLBACK_1', 'BNB_RPC_URL_FALLBACK_2'],
}

function fallbackAlchemyUrl(chainKey) {
  const key = process.env.ALCHEMY_API_KEY || process.env.VITE_ALCHEMY_API_KEY
  if (!key) return null
  if (chainKey === 'base') return `https://base-mainnet.g.alchemy.com/v2/${key}`
  if (chainKey === 'bnb') return `https://bnb-mainnet.g.alchemy.com/v2/${key}`
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`
}

export function rpcUrls(chainKey = 'eth') {
  const envKeys = CHAIN_RPC_ENV[chainKey] || CHAIN_RPC_ENV.eth
  const urls = envKeys.map((key) => process.env[key]).filter(Boolean)
  const alchemy = fallbackAlchemyUrl(chainKey)
  if (alchemy) urls.push(alchemy)
  return [...new Set(urls)]
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
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.error) {
        throw new Error(body?.error?.message || `RPC ${response.status}`)
      }
      const label = index === 0 ? 'primary' : `fallback_${index}`
      console.log(`rpc ${label} succeeded`, { chain: chainKey, method, latencyMs: Date.now() - started })
      return { result: body.result, rpcUrl: url, rpcIndex: index, latencyMs: Date.now() - started }
    } catch (error) {
      lastError = error
      console.error(`rpc attempt failed`, { chain: chainKey, method, rpcIndex: index, error: error.message })
    } finally {
      clearTimeout(timer)
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
