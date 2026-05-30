/**
 * Retry engine with exponential backoff, nonce management, and tx replacement.
 */

import { createLogger } from './logger.js'

const log = createLogger(null, null)

// ─── Error classification ─────────────────────────────────────────────────────

const ERROR_TYPE_CAPS = {
  revert:            0,
  nonce_too_low:     2,
  gas_too_low:       3,
  timeout:           4,
  network:           4,
  rate_limited:      3,
  dropped:           2,
  insufficient_funds: 0,  // terminal — retrying won't help until wallet is funded
  default:           3,
}

/**
 * Classify a viem / JSON-RPC error into a retry category.
 *
 * @param {unknown} error
 * @returns {{ type: string, retryable: boolean, maxRetries: number }}
 */
export function classifyError(error) {
  const msg = String(
    error?.shortMessage || error?.message || error || '',
  ).toLowerCase()
  const data = String(error?.details || error?.data || '').toLowerCase()
  const combined = `${msg} ${data}`

  if (
    combined.includes('revert') ||
    combined.includes('execution reverted') ||
    combined.includes('invalid opcode') ||
    combined.includes('out of gas') // contract-level OOG is a revert
  ) {
    return { type: 'revert', retryable: false, maxRetries: ERROR_TYPE_CAPS.revert }
  }

  // "insufficient funds for gas * price + value" — returned by every node when the
  // sender wallet has no ETH.  Non-retryable: the wallet must be funded first.
  if (
    combined.includes('insufficient funds') ||
    combined.includes('insufficient balance') ||
    combined.includes('sender balance') ||
    combined.includes('intrinsic gas cost exceeds gas limit') // alternative phrasing on some nodes
  ) {
    return { type: 'insufficient_funds', retryable: false, maxRetries: ERROR_TYPE_CAPS.insufficient_funds }
  }

  if (
    combined.includes('nonce too low') ||
    combined.includes('already known') ||
    combined.includes('replacement transaction underpriced') && combined.includes('nonce')
  ) {
    return { type: 'nonce_too_low', retryable: true, maxRetries: ERROR_TYPE_CAPS.nonce_too_low }
  }

  if (
    combined.includes('gas too low') ||
    combined.includes('max fee per gas less than block base fee') ||
    combined.includes('transaction underpriced') ||
    combined.includes('replacement transaction underpriced')
  ) {
    return { type: 'gas_too_low', retryable: true, maxRetries: ERROR_TYPE_CAPS.gas_too_low }
  }

  if (
    combined.includes('timeout') ||
    combined.includes('timed out') ||
    combined.includes('aborted') ||
    error?.name === 'AbortError'
  ) {
    return { type: 'timeout', retryable: true, maxRetries: ERROR_TYPE_CAPS.timeout }
  }

  if (
    combined.includes('network') ||
    combined.includes('fetch failed') ||
    combined.includes('econnreset') ||
    combined.includes('econnrefused') ||
    combined.includes('socket hang up') ||
    combined.includes('failed to fetch')
  ) {
    return { type: 'network', retryable: true, maxRetries: ERROR_TYPE_CAPS.network }
  }

  if (
    combined.includes('rate limit') ||
    combined.includes('too many requests') ||
    combined.includes('429') ||
    // Provider-specific rate-limit / capacity phrases
    combined.includes('cannot fulfill request') ||  // Infura / Tenderly overload
    combined.includes('limit exceeded') ||
    combined.includes('over limit') ||
    combined.includes('over rate limit') ||
    combined.includes('capacity exceeded') ||
    combined.includes('request limit') ||
    combined.includes('daily limit') ||
    combined.includes('compute units') ||             // Alchemy CU exhausted
    combined.includes('exceeded the quota') ||
    combined.includes('your app has exceeded')
  ) {
    return { type: 'rate_limited', retryable: true, maxRetries: ERROR_TYPE_CAPS.rate_limited }
  }

  if (
    combined.includes('dropped') ||
    combined.includes('underpriced') ||
    combined.includes('mempool')
  ) {
    return { type: 'dropped', retryable: true, maxRetries: ERROR_TYPE_CAPS.dropped }
  }

  if (
    // Generic node / provider errors that are transient
    combined.includes('internal server error') ||
    combined.includes('server error') ||
    combined.includes('service unavailable') ||
    combined.includes('bad gateway') ||
    combined.includes('gateway timeout') ||
    combined.includes('upstream') ||
    combined.includes('request failed') ||
    combined.includes('server is busy') ||
    combined.includes('try again') ||
    combined.includes('temporarily unavailable') ||
    combined.includes('execution error')            // catch-all for node execution faults
  ) {
    return { type: 'network', retryable: true, maxRetries: ERROR_TYPE_CAPS.network }
  }

  return { type: 'default', retryable: true, maxRetries: ERROR_TYPE_CAPS.default }
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 15_000

/**
 * Calculate how long to wait before a retry.
 * Uses exponential backoff with random jitter.
 *
 * @param {number} attempt  — 0-indexed attempt number
 * @param {string} [errorType]
 * @returns {number} milliseconds
 */
export function backoffMs(attempt, errorType = 'default') {
  const base = BACKOFF_BASE_MS * Math.pow(2, attempt)
  const jitter = Math.random() * 200
  return Math.min(base + jitter, BACKOFF_MAX_MS)
}

/**
 * Congestion-aware backoff: adjusts delay based on network state.
 * Under high congestion conditions change fast → shorter waits.
 * For rate-limits or dropped tx → longer waits.
 *
 * @param {number} attempt
 * @param {string} [errorType]
 * @param {'low'|'medium'|'high'|'extreme'} [congestionLevel]
 * @returns {number} milliseconds
 */
export function congestionAwareBackoffMs(attempt, errorType = 'default', congestionLevel = 'medium') {
  let base = backoffMs(attempt, errorType)

  // Rate limits: always back off hard regardless of congestion
  if (errorType === 'rate_limited') {
    return Math.min(base * 2, BACKOFF_MAX_MS)
  }

  // High congestion: shorten wait — conditions are changing fast
  if (congestionLevel === 'high' || congestionLevel === 'extreme') {
    if (errorType === 'gas_too_low') {
      // Gas is spiking — re-estimate quickly
      base = Math.min(base * 0.5, 2_000)
    } else if (errorType === 'timeout' || errorType === 'network') {
      // RPC under load — try next provider sooner
      base = Math.min(base * 0.7, 3_000)
    }
  }

  // Low congestion: standard backoff is fine
  return base
}

// ─── Nonce tracker ────────────────────────────────────────────────────────────

/** In-memory nonce tracking keyed by lowercase address */
// SCALE-1: nonceTracker is in-memory — it resets on every worker restart.
// After a restart, executor.js re-syncs the nonce from the chain on first use
// (see Step 6b in executor.js: `if (!nonceTracker.has(addr)) sync from chain`).
// This means the first tx after a restart always does one extra RPC call, which
// is acceptable. It does NOT cause nonce collisions because the chain is the
// source of truth for the initial value.
//
// Do NOT persist nonceTracker to DB/Redis — a stale persisted nonce is harder
// to recover from than a fresh chain sync on restart.
const _nonceStore = new Map()

export const nonceTracker = {
  /**
   * Get cached nonce for address, or undefined if not tracked.
   * @param {string} address
   * @returns {number|undefined}
   */
  get(address) {
    return _nonceStore.get(address.toLowerCase())
  },

  /**
   * Set nonce for address.
   * @param {string} address
   * @param {number} nonce
   */
  set(address, nonce) {
    _nonceStore.set(address.toLowerCase(), nonce)
  },

  /**
   * Increment the tracked nonce by 1 (call after successful tx submission).
   * @param {string} address
   */
  increment(address) {
    const key = address.toLowerCase()
    const current = _nonceStore.get(key)
    if (current !== undefined) {
      _nonceStore.set(key, current + 1)
    }
  },

  /**
   * Check whether a nonce is tracked for address.
   * @param {string} address
   * @returns {boolean}
   */
  has(address) {
    return _nonceStore.has(address.toLowerCase())
  },

  /**
   * Remove tracked nonce for address (call after terminal tx failure so next
   * execution re-syncs the correct nonce from the chain instead of using a
   * ghost-advanced value).
   * @param {string} address
   */
  clear(address) {
    _nonceStore.delete(address.toLowerCase())
  },
}

// ─── withRetry ────────────────────────────────────────────────────────────────

/**
 * Execute `fn` with automatic retry according to error type.
 *
 * @param {() => Promise<unknown>} fn
 * @param {{
 *   intentId?: string,
 *   userId?: string,
 *   enabled?: boolean,
 *   onRetry?: (attempt: number, error: unknown, classification: object) => void | Promise<void>,
 *   gasParams?: object,
 *   address?: string,
 *   publicClient?: import('viem').PublicClient,
 * }} options
 * @returns {Promise<unknown>}
 */
export async function withRetry(fn, options = {}) {
  const {
    intentId = null,
    userId = null,
    enabled = true,
    onRetry = null,
    address = null,
    publicClient = null,
  } = options

  const retryLog = createLogger(intentId, userId)
  let attempt = 0
  let lastError

  while (true) {
    try {
      const result = await fn(attempt)
      // NOTE: nonce is NOT incremented here. executor.js pre-sets nonceTracker to
      // nonce+1 *before* sendTransaction so concurrent executors see the correct next
      // slot immediately. Adding an increment here would double-count and cause
      // nonce-too-low on the very next tx from the same wallet. (OPS-5)
      return result
    } catch (err) {
      lastError = err
      const classification = classifyError(err)

      retryLog.warn('retry', 'Execution attempt failed', {
        attempt,
        error_type: classification.type,
        retryable: classification.retryable,
        max_retries: classification.maxRetries,
        error: String(err?.shortMessage || err?.message || err),
      })

      // Never retry non-retryable errors
      if (!classification.retryable) {
        throw err
      }

      // Retry limit reached
      if (!enabled || attempt >= classification.maxRetries) {
        throw err
      }

      // Handle nonce_too_low: refresh nonce from chain
      if (classification.type === 'nonce_too_low' && address && publicClient) {
        try {
          const freshNonce = await publicClient.getTransactionCount({
            address,
            blockTag: 'pending',
          })
          nonceTracker.set(address, freshNonce)
          retryLog.info('retry', 'Refreshed nonce from chain', {
            address,
            nonce: freshNonce,
          })
        } catch (nonceErr) {
          retryLog.warn('retry', 'Failed to refresh nonce', { error: nonceErr.message })
        }
      }

      const delay = backoffMs(attempt, classification.type)
      retryLog.info('retry', 'Waiting before retry', {
        attempt,
        delay_ms: Math.round(delay),
        next_attempt: attempt + 1,
      })

      if (onRetry) {
        await onRetry(attempt, err, classification)
      }

      await new Promise(resolve => setTimeout(resolve, delay))
      attempt += 1
    }
  }
}
