/**
 * Private mempool submission transport.
 *
 * For FCFS intents, routes eth_sendRawTransaction to:
 *   - Base: Coinbase sequencer (https://mainnet-sequencer.base.org) — bypasses public p2p gossip
 *   - Ethereum: Flashbots relay (https://rpc.flashbots.net) — eth_sendPrivateTransaction
 *
 * Falls back silently to the standard public RPC on any failure or timeout.
 * All other JSON-RPC methods (eth_chainId, eth_getBlockByNumber, etc.) pass through unchanged.
 *
 * Env vars (Railway worker service):
 *   PRIVATE_SUBMIT_ENABLED  — activate in executor.js (checked there, not here)
 *   BASE_SEQUENCER_URL      — override Base endpoint (default: https://mainnet-sequencer.base.org)
 *   FLASHBOTS_AUTH_KEY      — optional Ethereum private key for MEV-Share auth signature
 */

import { custom, keccak256, fromHex, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { log as globalLog } from './logger.js'
import { rpcFetch } from './rpc.js'

// ─── Private endpoint registry ────────────────────────────────────────────────

const PRIVATE_ENDPOINTS = {
  // Coinbase sequencer — receives the tx before public p2p propagation
  base: () => process.env.BASE_SEQUENCER_URL || 'https://mainnet-sequencer.base.org',
  // Flashbots MEV-Share relay — keeps tx off the public mempool
  eth: () => 'https://rpc.flashbots.net',
  // apechain / bnb — no known private endpoints; fall through to public
}

// ─── Private send helpers ─────────────────────────────────────────────────────

/**
 * Build the X-Flashbots-Signature header value if FLASHBOTS_AUTH_KEY is set.
 * The signature is EIP-191 personal_sign of keccak256(requestBody).
 *
 * @param {string} bodyStr  — JSON-serialised request body
 * @returns {Promise<string|null>}
 */
async function buildFlashbotsSignature(bodyStr) {
  const key = process.env.FLASHBOTS_AUTH_KEY
  if (!key) return null
  try {
    const account  = privateKeyToAccount(key)
    const bodyHash = keccak256(toBytes(bodyStr))
    const sig      = await account.signMessage({ message: { raw: fromHex(bodyHash, 'bytes') } })
    return `${account.address}:${sig}`
  } catch (err) {
    globalLog.warn('execute', 'Failed to build Flashbots signature — sending without auth', {
      error: String(err?.message || err).slice(0, 80),
    })
    return null
  }
}

/**
 * Submit a signed transaction to the chain's private endpoint.
 * Returns the tx hash on success, throws on any failure.
 *
 * @param {string} chainKey  — 'base' | 'eth' (others throw immediately)
 * @param {string} signedTx  — 0x-prefixed hex encoded signed transaction
 * @returns {Promise<string>}
 */
async function sendToPrivateEndpoint(chainKey, signedTx) {
  const endpointFn = PRIVATE_ENDPOINTS[chainKey]
  if (!endpointFn) throw new Error(`no private endpoint for chain: ${chainKey}`)
  const url = endpointFn()

  // ── Ethereum: Flashbots eth_sendPrivateTransaction ──────────────────────────
  if (chainKey === 'eth') {
    const requestBody = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_sendPrivateTransaction',
      params: [{ tx: signedTx }],
    }
    const bodyStr  = JSON.stringify(requestBody)
    const authSig  = await buildFlashbotsSignature(bodyStr)
    const headers  = { 'Content-Type': 'application/json' }
    if (authSig) headers['X-Flashbots-Signature'] = authSig

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 5000)
    try {
      const res  = await fetch(url, { method: 'POST', headers, body: bodyStr, signal: controller.signal })
      const json = await res.json()
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error))
      return json.result
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Base: standard eth_sendRawTransaction to sequencer ─────────────────────
  const bodyStr  = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_sendRawTransaction', params: [signedTx] })
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), 5000)
  try {
    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyStr, signal: controller.signal })
    const json = await res.json()
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error))
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

// ─── Transport factory ────────────────────────────────────────────────────────

/**
 * Create a viem transport that intercepts eth_sendRawTransaction and routes it
 * through the chain's private endpoint, falling back to the public RPC on failure.
 *
 * All other RPC methods (eth_chainId, eth_getTransactionCount, eth_getBlockByNumber, …)
 * pass through to rpcFetch unchanged — no extra latency for non-broadcast calls.
 *
 * @param {string} chainKey          — normalised chain key ('base' | 'eth' | 'apechain' | 'bnb')
 * @param {import('viem').Transport} _baseTransport — kept for API clarity; fallback uses rpcFetch directly
 * @returns {import('viem').Transport}
 */
export function createPrivateViemTransport(chainKey, _baseTransport) {
  return custom({
    async request({ method, params }) {
      // eth_fillTransaction is non-standard — reject immediately so viem builds the tx itself
      if (method === 'eth_fillTransaction') {
        throw Object.assign(new Error('eth_fillTransaction not supported'), { code: -32601 })
      }

      // Only intercept the actual broadcast call and only for supported chains
      if (method === 'eth_sendRawTransaction' && PRIVATE_ENDPOINTS[chainKey]) {
        const signedTx = params?.[0]
        try {
          const txHash = await sendToPrivateEndpoint(chainKey, signedTx)
          globalLog.info('execute', 'private_ok — tx submitted via private endpoint', {
            chain:    chainKey,
            endpoint: chainKey === 'eth' ? 'flashbots' : 'sequencer',
            tx_hash:  String(txHash || '').slice(0, 22),
          })
          return txHash
        } catch (err) {
          globalLog.warn('execute', 'private_fallback — private endpoint failed, falling back to public RPC', {
            chain: chainKey,
            error: String(err?.message || err).slice(0, 120),
          })
          // Fall through to public rpcFetch below
        }
      }

      // Default path: public RPC with latency-scored failover
      const { result } = await rpcFetch(chainKey, method, params || [])
      return result
    },
  })
}
