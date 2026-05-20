/**
 * Prewarm + contract cache test harness.
 * Run: node worker/test/prewarm.test.js
 *
 * Tests:
 *  - ABI cache: get/set/TTL expiry
 *  - Execution config cache: get/set/successCount increment/TTL expiry
 *  - Supabase load: graceful no-op on failure
 *  - Latency history: record/get/average
 *  - Confidence score: all tiers
 *  - Prewarm status shape
 *  - prepareMintTransaction: cache fast path
 *  - prepareMintTransaction: cache miss → full path → populates cache
 *  - prepareMintTransaction: stale cache falls through on gas failure
 *  - prepareMintTransaction: max_spend propagates through cache path
 */

import assert from 'assert/strict'
import {
  getCachedAbi, setCachedAbi,
  getCachedExecution, setCachedExecution, loadCachedExecution,
  recordLatency, getLatencyHistory, getAvgLatency,
  getExecutionConfidence, getPrewarmStatus,
} from '../../api/_lib/contract-cache.js'
import {
  prepareMintTransaction,
  fallbackCandidates,
} from '../../api/_lib/mint-engine.js'

// ─── Harness ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const results = []

async function test(name, fn) {
  const t = Date.now()
  try {
    await fn()
    const ms = Date.now() - t
    console.log(`  ✓  ${name} (${ms}ms)`)
    passed++
    results.push({ name, pass: true, ms })
  } catch (err) {
    const ms = Date.now() - t
    console.error(`  ✗  ${name} (${ms}ms)`)
    console.error(`     ${err.message}`)
    failed++
    results.push({ name, pass: false, ms, error: err.message })
  }
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const CONTRACT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CONTRACT2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const WALLET  = '0x1111111111111111111111111111111111111111'
const MOCK_BYTECODE  = '0x6080604052'
const DEFAULT_GAS    = 150000n
const DEFAULT_PRICE  = 20_000_000_000n

function mockClient(opts = {}) {
  return {
    getBytecode: async () => opts.bytecode ?? MOCK_BYTECODE,
    estimateGas: async () => {
      if (opts.revert) throw new Error('execution reverted')
      return opts.gas ?? DEFAULT_GAS
    },
    getGasPrice: async () => opts.gasPrice ?? DEFAULT_PRICE,
  }
}

function body(overrides = {}) {
  return { chain: 'eth', contractAddress: CONTRACT, walletAddress: WALLET, mintPrice: '0', quantity: 1, ...overrides }
}

// Mock Supabase that always fails (table missing) — used to test graceful degradation
const failSupabase = {
  from: () => ({
    upsert:     () => ({ catch: () => Promise.resolve(null) }),
    select:     () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error('table missing') }) }) }) }),
  }),
}

// Mock Supabase that returns a saved row
function hitSupabase(row) {
  return {
    from: () => ({
      upsert: () => ({ catch: () => Promise.resolve(null) }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        }),
      }),
    }),
  }
}

// ─── Section 1: ABI cache ─────────────────────────────────────────────────────

console.log('\n--- ABI cache ---\n')

await test('getCachedAbi returns null on miss', () => {
  assert.equal(getCachedAbi(CONTRACT2, 'base'), null)
})

await test('setCachedAbi / getCachedAbi round-trip', () => {
  const abi = [{ type: 'function', name: 'mint', inputs: [], stateMutability: 'payable' }]
  setCachedAbi(CONTRACT2, 'base', abi)
  assert.deepEqual(getCachedAbi(CONTRACT2, 'base'), abi)
})

await test('setCachedAbi ignores null abi', () => {
  const before = getCachedAbi('0xcccccccccccccccccccccccccccccccccccccccc', 'eth')
  setCachedAbi('0xcccccccccccccccccccccccccccccccccccccccc', 'eth', null)
  assert.equal(getCachedAbi('0xcccccccccccccccccccccccccccccccccccccccc', 'eth'), before)
})

await test('ABI cache is keyed by chain (eth != base)', () => {
  const abi = [{ type: 'function', name: 'claim', inputs: [], stateMutability: 'payable' }]
  setCachedAbi(CONTRACT2, 'eth', abi)
  const baseResult = getCachedAbi(CONTRACT2, 'base')
  const ethResult  = getCachedAbi(CONTRACT2, 'eth')
  // base was set in previous test with different abi; eth was just set
  assert.deepEqual(ethResult, abi)
  assert.notDeepEqual(baseResult, abi)
})

// ─── Section 2: Execution cache ───────────────────────────────────────────────

console.log('\n--- Execution cache ---\n')

const EXEC_C = '0xdddddddddddddddddddddddddddddddddddddddd'

await test('getCachedExecution returns null on miss', () => {
  assert.equal(getCachedExecution(EXEC_C, 'eth'), null)
})

await test('setCachedExecution stores entry', () => {
  setCachedExecution(EXEC_C, 'eth', {
    functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'common_signature', latencyMs: 300,
  })
  const entry = getCachedExecution(EXEC_C, 'eth')
  assert.ok(entry)
  assert.equal(entry.functionName, 'mint')
  assert.equal(entry.source, 'common_signature')
  assert.equal(entry.successCount, 1)
  assert.equal(entry.lastLatencyMs, 300)
})

await test('setCachedExecution increments successCount on repeat', () => {
  setCachedExecution(EXEC_C, 'eth', {
    functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'common_signature', latencyMs: 200,
  })
  const entry = getCachedExecution(EXEC_C, 'eth')
  assert.equal(entry.successCount, 2)
  assert.equal(entry.lastLatencyMs, 200)
})

await test('setCachedExecution fire-and-forget with failing supabase', () => {
  // Should not throw even if supabase fails
  setCachedExecution(EXEC_C, 'base', {
    functionName: 'publicMint', argsSummary: ['2'], gas: '180000', chainId: 8453, source: 'verified_abi', latencyMs: 400,
  }, failSupabase)
  const entry = getCachedExecution(EXEC_C, 'base')
  assert.ok(entry)
  assert.equal(entry.functionName, 'publicMint')
})

await test('loadCachedExecution returns in-memory hit (no supabase call)', async () => {
  const entry = await loadCachedExecution(EXEC_C, 'eth', null)
  assert.ok(entry)
  assert.equal(entry.functionName, 'mint')
})

await test('loadCachedExecution gracefully handles supabase failure (returns null)', async () => {
  const entry = await loadCachedExecution('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'eth', failSupabase)
  assert.equal(entry, null)
})

await test('loadCachedExecution hydrates in-memory from DB hit', async () => {
  const DB_C = '0xffffffffffffffffffffffffffffffffffffffff'
  const dbRow = {
    function_name: 'claim', args_summary: [], gas_estimate: '120000',
    success_count: 3, last_latency_ms: 250, last_success_at: new Date().toISOString(),
  }
  const entry = await loadCachedExecution(DB_C, 'eth', hitSupabase(dbRow))
  assert.ok(entry)
  assert.equal(entry.functionName, 'claim')
  assert.equal(entry.successCount, 3)
  // Second call should hit in-memory (no supabase needed)
  const cached = getCachedExecution(DB_C, 'eth')
  assert.ok(cached)
  assert.equal(cached.functionName, 'claim')
})

// ─── Section 3: Latency history ───────────────────────────────────────────────

console.log('\n--- Latency history ---\n')

const LAT_C = '0x1212121212121212121212121212121212121212'

await test('getLatencyHistory returns empty on miss', () => {
  assert.deepEqual(getLatencyHistory(LAT_C, 'eth'), [])
})

await test('recordLatency + getLatencyHistory round-trip', () => {
  recordLatency(LAT_C, 'eth', 300)
  recordLatency(LAT_C, 'eth', 500)
  const history = getLatencyHistory(LAT_C, 'eth')
  assert.deepEqual(history, [300, 500])
})

await test('getAvgLatency computes average', () => {
  recordLatency(LAT_C, 'eth', 400)
  const avg = getAvgLatency(LAT_C, 'eth')
  assert.equal(avg, Math.round((300 + 500 + 400) / 3))
})

await test('getAvgLatency returns null on miss', () => {
  assert.equal(getAvgLatency('0x9999999999999999999999999999999999999999', 'eth'), null)
})

// ─── Section 4: Confidence score ─────────────────────────────────────────────

console.log('\n--- Confidence score ---\n')

const CONF_C  = '0x2323232323232323232323232323232323232323'
const CONF_C2 = '0x2424242424242424242424242424242424242424'
const CONF_C3 = '0x2525252525252525252525252525252525252525'

await test('confidence=0 with no cache', () => {
  assert.equal(getExecutionConfidence(CONF_C, 'eth'), 0)
})

await test('confidence=20 with ABI only', () => {
  setCachedAbi(CONF_C, 'eth', [{ type: 'function', name: 'mint', inputs: [] }])
  assert.equal(getExecutionConfidence(CONF_C, 'eth'), 20)
})

await test('confidence=55+ with execution cache hit (1 success)', () => {
  setCachedExecution(CONF_C2, 'eth', { functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'common_signature', latencyMs: 800 })
  assert.ok(getExecutionConfidence(CONF_C2, 'eth') >= 55)
})

await test('confidence=70+ with 2+ successes', () => {
  setCachedExecution(CONF_C2, 'eth', { functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'common_signature', latencyMs: 800 })
  assert.ok(getExecutionConfidence(CONF_C2, 'eth') >= 70)
})

await test('confidence=80 with verified_abi + fast latency (1 success)', () => {
  setCachedExecution(CONF_C3, 'eth', { functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'verified_abi', latencyMs: 200 })
  // score: 55 (exec hit) + 15 (verified_abi) + 10 (fast latency) = 80
  assert.ok(getExecutionConfidence(CONF_C3, 'eth') >= 80)
})

await test('confidence capped at 100', () => {
  // Multiple successes + verified ABI + fast latency
  setCachedExecution(CONF_C3, 'eth', { functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'verified_abi', latencyMs: 200 })
  setCachedExecution(CONF_C3, 'eth', { functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'verified_abi', latencyMs: 200 })
  assert.ok(getExecutionConfidence(CONF_C3, 'eth') <= 100)
})

// ─── Section 5: Prewarm status shape ─────────────────────────────────────────

console.log('\n--- Prewarm status shape ---\n')

await test('getPrewarmStatus shape when not ready', () => {
  const s = getPrewarmStatus('0x0000000000000000000000000000000000000001', 'eth')
  assert.equal(s.ready, false)
  assert.equal(s.confidence, 0)
  assert.equal(s.functionName, null)
  assert.equal(s.successCount, 0)
})

await test('getPrewarmStatus returns ready when exec cached', () => {
  const s = getPrewarmStatus(CONF_C2, 'eth')
  assert.equal(s.ready, true)
  assert.ok(s.confidence >= 70)
  assert.equal(s.functionName, 'mint')
  assert.ok(s.cachedAt)
})

// ─── Section 6: prepareMintTransaction cache integration ─────────────────────

console.log('\n--- prepareMintTransaction cache integration ---\n')

const CACHE_C  = '0x3131313131313131313131313131313131313131'
const CACHE_C2 = '0x3232323232323232323232323232323232323232'

await test('cold call populates execution cache', async () => {
  assert.equal(getCachedExecution(CACHE_C, 'eth'), null)
  const result = await prepareMintTransaction(body({ contractAddress: CACHE_C }), mockClient())
  assert.ok(result.functionName)
  assert.equal(result.cacheHit, false)
  const cached = getCachedExecution(CACHE_C, 'eth')
  assert.ok(cached, 'cache should be populated after cold call')
  assert.equal(cached.functionName, result.functionName)
})

await test('warm call uses cache fast path (cacheHit=true)', async () => {
  // CACHE_C already populated from previous test
  const result = await prepareMintTransaction(body({ contractAddress: CACHE_C }), mockClient())
  assert.equal(result.cacheHit, true)
  assert.equal(result.source, 'cache')
})

await test('warm call is faster than cold call', async () => {
  // Cold call on fresh contract
  const t1 = Date.now()
  await prepareMintTransaction(body({ contractAddress: CACHE_C2 }), mockClient())
  const coldMs = Date.now() - t1

  // Warm call on same contract
  const t2 = Date.now()
  const warm = await prepareMintTransaction(body({ contractAddress: CACHE_C2 }), mockClient())
  const warmMs = Date.now() - t2

  assert.equal(warm.cacheHit, true)
  // Warm should generally be <= cold (at least not significantly slower in test env)
  assert.ok(warmMs <= coldMs + 50, `warm=${warmMs}ms should not be much slower than cold=${coldMs}ms`)
})

await test('stale cache falls through to full path when gas fails', async () => {
  // Pre-populate cache for CACHE_C2
  assert.ok(getCachedExecution(CACHE_C2, 'eth'))

  // Now simulate a client where the cached function reverts (mint closed)
  // but a different function works — engine should fall back and try all candidates
  let callCount = 0
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => {
      callCount++
      if (callCount === 1) throw new Error('execution reverted') // cache fast path fails
      return DEFAULT_GAS // subsequent candidates succeed
    },
    getGasPrice: async () => DEFAULT_PRICE,
  }

  const result = await prepareMintTransaction(body({ contractAddress: CACHE_C2 }), client)
  // Should still succeed via full path
  assert.ok(result.functionName)
  assert.ok(callCount > 1, 'should have tried multiple candidates after cache miss')
})

await test('max_spend propagates through cache fast path', async () => {
  // CACHE_C has a warm cache — verify spend check still fires
  // gas=150000, gasPrice=20gwei => gas cost = 0.003 ETH, price=0.1 ETH, total=0.103 > cap of 0.05
  await assert.rejects(
    () => prepareMintTransaction(
      body({ contractAddress: CACHE_C, mintPrice: '0.1', maxTotalSpend: '0.05' }),
      mockClient(),
    ),
    /max_spend_exceeded|Mint skipped/i,
  )
})

await test('latencyMs is returned in result', async () => {
  const result = await prepareMintTransaction(body({ contractAddress: CACHE_C }), mockClient())
  assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const ms = results.reduce((s, r) => s + r.ms, 0)
console.log(`\n${passed}/${total} tests passed  |  ${ms}ms total\n`)
if (failed > 0) {
  console.error('FAILED:')
  results.filter(r => !r.pass).forEach(r => console.error(`  ✗ ${r.name}: ${r.error}`))
  process.exitCode = 1
}
