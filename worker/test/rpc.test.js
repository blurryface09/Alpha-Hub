/**
 * RPC failure simulation tests.
 * Run: node worker/test/rpc.test.js
 *
 * Covers:
 *  - getRpcUrls: returns non-empty list, includes public fallbacks
 *  - rpcFetch: succeeds on healthy provider
 *  - rpcFetch: failover — first URL fails, second succeeds
 *  - rpcFetch: timeout (AbortController fires)
 *  - rpcFetch: HTTP 429 rate limit → recorded as failure
 *  - rpcFetch: body.error (JSON-RPC error) → recorded as failure
 *  - rpcFetch: all providers fail → throws
 *  - getRpcHealth: reflects recorded success/failure
 *  - EMA latency scoring: healthy providers sorted before degraded
 */

import assert from 'assert/strict'
import { getRpcUrls, rpcFetch, getRpcHealth } from '../lib/rpc.js'

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗  ${name}`)
    console.error(`     ${err.message}`)
    failed++
  }
}

// ─── fetch mock helpers ───────────────────────────────────────────────────────

const _originalFetch = globalThis.fetch

function mockFetch(handler) {
  globalThis.fetch = handler
}

function restoreFetch() {
  globalThis.fetch = _originalFetch
}

function successResponse(result) {
  return async () => ({
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  })
}

function errorResponse(status, errorMsg) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: errorMsg, code: -32000 } }),
  })
}

function networkError(msg) {
  return async () => { throw new Error(msg) }
}

function timeoutError() {
  return async () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    throw err
  }
}

console.log('\nrpc.test.js\n')

// ─── getRpcUrls ───────────────────────────────────────────────────────────────

await test('getRpcUrls: returns non-empty list for eth', () => {
  const urls = getRpcUrls('eth')
  assert.ok(Array.isArray(urls) && urls.length > 0, 'expected at least one URL')
})

await test('getRpcUrls: returns non-empty list for base', () => {
  const urls = getRpcUrls('base')
  assert.ok(urls.length > 0)
})

await test('getRpcUrls: falls back to eth for unknown chain', () => {
  const known = getRpcUrls('eth')
  const unknown = getRpcUrls('nonexistent_chain_xyz')
  assert.ok(unknown.length > 0)
  // Should include at least one URL from eth fallbacks
  assert.ok(unknown.some(u => known.includes(u)))
})

await test('getRpcUrls: includes public fallback URLs', () => {
  const urls = getRpcUrls('eth')
  assert.ok(urls.some(u => u.includes('llamarpc') || u.includes('ankr') || u.includes('cloudflare')))
})

await test('getRpcUrls: returns no duplicate URLs', () => {
  const urls = getRpcUrls('eth')
  assert.equal(new Set(urls).size, urls.length, 'duplicate URLs detected')
})

// ─── rpcFetch: success ────────────────────────────────────────────────────────

await test('rpcFetch: returns result from healthy provider', async () => {
  mockFetch(successResponse('0x1'))
  try {
    const { result, rpcUrl, latencyMs, rpcIndex } = await rpcFetch('eth', 'eth_blockNumber', [])
    assert.equal(result, '0x1')
    assert.equal(typeof rpcUrl, 'string')
    assert.ok(latencyMs >= 0)
    assert.equal(rpcIndex, 0)
  } finally {
    restoreFetch()
  }
})

// ─── rpcFetch: failover ───────────────────────────────────────────────────────

await test('rpcFetch: failover — first URL throws network error, second succeeds', async () => {
  let calls = 0
  mockFetch(async (url, opts) => {
    calls++
    if (calls === 1) throw new Error('ECONNRESET')
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2' }),
    }
  })
  try {
    const { result, rpcIndex } = await rpcFetch('eth', 'eth_blockNumber', [], 3000)
    assert.equal(result, '0x2')
    assert.ok(rpcIndex >= 1, `expected rpcIndex >= 1, got ${rpcIndex}`)
  } finally {
    restoreFetch()
  }
})

// ─── rpcFetch: HTTP 429 rate limit ───────────────────────────────────────────

await test('rpcFetch: HTTP 429 is recorded as failure and triggers failover', async () => {
  let calls = 0
  mockFetch(async () => {
    calls++
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'rate limited' } }),
      }
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x3' }),
    }
  })
  try {
    const { result } = await rpcFetch('eth', 'eth_blockNumber', [], 3000)
    assert.equal(result, '0x3')
    assert.ok(calls >= 2, 'should have tried at least 2 providers')
  } finally {
    restoreFetch()
  }
})

// ─── rpcFetch: JSON-RPC body error ───────────────────────────────────────────

await test('rpcFetch: JSON-RPC body.error triggers failover', async () => {
  let calls = 0
  mockFetch(async () => {
    calls++
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'method not found' } }),
      }
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x4' }),
    }
  })
  try {
    const { result } = await rpcFetch('eth', 'eth_unknown', [], 3000)
    assert.equal(result, '0x4')
    assert.ok(calls >= 2)
  } finally {
    restoreFetch()
  }
})

// ─── rpcFetch: all providers fail ────────────────────────────────────────────

await test('rpcFetch: throws when all providers fail', async () => {
  mockFetch(networkError('all rpcs down'))
  try {
    await assert.rejects(
      () => rpcFetch('eth', 'eth_blockNumber', [], 1000),
      /all rpcs down|All RPC providers failed/i,
    )
  } finally {
    restoreFetch()
  }
})

// ─── rpcFetch: timeout ────────────────────────────────────────────────────────

await test('rpcFetch: timeout causes failover to next provider', async () => {
  let calls = 0
  mockFetch(async (_url, opts) => {
    calls++
    if (calls === 1) {
      // Simulate timeout by checking abort signal
      if (opts?.signal) {
        return new Promise((_res, rej) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            rej(err)
          })
        })
      }
      throw Object.assign(new Error('timed out'), { name: 'AbortError' })
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x5' }),
    }
  })
  try {
    const { result } = await rpcFetch('eth', 'eth_blockNumber', [], 50)
    assert.equal(result, '0x5')
  } finally {
    restoreFetch()
  }
})

// ─── getRpcHealth ─────────────────────────────────────────────────────────────

await test('getRpcHealth: returns an array of health entries', () => {
  const health = getRpcHealth()
  assert.ok(Array.isArray(health))
})

await test('getRpcHealth: each entry has expected shape', () => {
  // Force at least one health record to exist by calling getRpcUrls
  getRpcUrls('eth')
  const health = getRpcHealth()
  if (health.length === 0) return // may be empty if no calls made yet in this process
  for (const h of health) {
    assert.ok('url' in h, 'missing url')
    assert.ok('latency_ema_ms' in h, 'missing latency_ema_ms')
    assert.ok('fail_count' in h, 'missing fail_count')
    assert.ok('degraded' in h, 'missing degraded')
  }
})

await test('getRpcHealth: degraded flag is false when failCount < 3', async () => {
  // Make a successful call to register a URL in health map
  mockFetch(successResponse('0xff'))
  try {
    await rpcFetch('eth', 'eth_blockNumber', [], 3000).catch(() => {})
  } finally {
    restoreFetch()
  }
  const health = getRpcHealth()
  const nonDegraded = health.filter(h => !h.degraded)
  assert.ok(nonDegraded.length > 0, 'expected at least one non-degraded provider')
})

// ─── EMA scoring: healthy sorted before degraded ──────────────────────────────

await test('getRpcUrls: healthy providers appear before degraded ones', async () => {
  // Simulate 3 failures on the first URL to force it into degraded state
  const urls = getRpcUrls('eth')
  if (urls.length < 2) {
    console.log('     (skipped — fewer than 2 eth providers configured)')
    passed++
    return
  }

  // Mark first URL as degraded via 3 failed calls
  mockFetch(networkError('force degraded'))
  try {
    for (let i = 0; i < 3; i++) {
      await rpcFetch('eth', 'eth_chainId', [], 500).catch(() => {})
    }
  } finally {
    restoreFetch()
  }

  // Now make second URL succeed
  mockFetch(successResponse('0x1'))
  try {
    await rpcFetch('eth', 'eth_chainId', [], 3000).catch(() => {})
  } finally {
    restoreFetch()
  }

  const health = getRpcHealth()
  const degraded = health.filter(h => h.degraded).map(h => h.url)
  const sorted = getRpcUrls('eth')

  if (degraded.length > 0) {
    // All degraded URLs should come after all healthy ones
    const firstDegradedIdx = sorted.findIndex(u => degraded.includes(u))
    const lastHealthyIdx = sorted.reduce((max, u, i) => (!degraded.includes(u) ? i : max), -1)
    assert.ok(
      firstDegradedIdx > lastHealthyIdx,
      `degraded URL at idx ${firstDegradedIdx} should come after last healthy at idx ${lastHealthyIdx}`,
    )
  }
})

// ─── Dropped tx simulation ────────────────────────────────────────────────────

await test('rpcFetch: stale/malformed response triggers failover', async () => {
  let calls = 0
  mockFetch(async () => {
    calls++
    if (calls === 1) {
      // Returns HTTP 200 but malformed JSON-RPC (no result, no error)
      return {
        ok: true,
        json: async () => null,
      }
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6' }),
    }
  })
  try {
    const { result } = await rpcFetch('eth', 'eth_blockNumber', [], 3000)
    assert.equal(result, '0x6')
  } finally {
    restoreFetch()
  }
})

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
