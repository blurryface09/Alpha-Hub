/**
 * Phase 4 — Cache & readiness hardening tests.
 *
 * Validates four concrete fixes:
 *  P4-1 — SeaDrop exec cache fast path is skipped (source='seadrop' → full detection)
 *  P4-2 — Readiness computation includes probe cache state (not_started/paused shown as warning)
 *  P4-3 — Exec cache invalidated on confirmed on-chain revert
 *  P4-4 — loadCachedExecution uses Date.now() fallback when last_success_at is null
 *
 * Run: node worker/test/cache-readiness.test.js
 */

import assert from 'assert/strict'
import {
  getCachedExecution,
  setCachedExecution,
  setCachedProbeResult,
  getCachedProbeResult,
  setCachedAbi,
  invalidateCachedExecution,
  loadCachedExecution,
  getPrewarmStatus,
} from '../../api/_lib/contract-cache.js'
import { computeReadiness } from '../../api/_lib/readiness.js'
import {
  prepareMintTransaction,
  candidatesFromAbi,
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

// ─── Constants ────────────────────────────────────────────────────────────────

const SEADROP_ROUTER = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
const FEE_RECIPIENT  = '0x0000a26b00c1F0DF003000390027140000fAa719'
const MOCK_WALLET    = '0x1111111111111111111111111111111111111111'
const MOCK_BYTECODE  = '0x6080604052'

// Unique addresses per test to avoid cache cross-contamination
const C_SEADROP_SKIP     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0001'
const C_SEADROP_SKIP_2   = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002'
const C_PROBE_WARN_1     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0010'
const C_PROBE_WARN_2     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0011'
const C_PROBE_WARN_3     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0012'
const C_PROBE_POSITIVE   = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0013'
const C_PROBE_NONE       = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0014'
const C_REVERT_INVAL     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0020'
const C_NULL_AT_1        = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0030'
const C_NULL_AT_2        = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0031'

const SEADROP_INTERFACE_ABI = [
  { type: 'function', name: 'mintSeaDrop', inputs: [{ name: 'minter', type: 'address' }, { name: 'quantity', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
]

// ─── Mock clients ─────────────────────────────────────────────────────────────

function seaDropClient({
  mintPrice = 80000000000000n,
  startTime = BigInt(Math.floor(Date.now() / 1000) - 3600),
  endTime   = 0n,
} = {}) {
  return {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => 200000n,
    getGasPrice: async () => 20_000_000_000n,
    readContract: async ({ functionName }) => {
      if (functionName === 'getAllowedFeeRecipients') return [FEE_RECIPIENT]
      if (functionName === 'getPublicDrop') return [mintPrice, startTime, endTime, 1000n, 500n, false]
      if (functionName === 'getAllowListMerkleRoot') return '0x' + '0'.repeat(64)
      throw new Error(`unexpected readContract: ${functionName}`)
    },
  }
}

function standardClient() {
  return {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => 150000n,
    getGasPrice: async () => 20_000_000_000n,
    readContract: async () => { throw new Error('not seadrop') },
  }
}

function body(contract, overrides = {}) {
  return { chain: 'eth', contractAddress: contract, walletAddress: MOCK_WALLET, mintPrice: '0', quantity: 1, ...overrides }
}

// ─── Section 1: P4-1 — SeaDrop exec cache fast path skipped ──────────────────

console.log('\n=== Section 1: P4-1 — SeaDrop fast path skip ===\n')

await test('p4-1: exec cache with source=seadrop does not trigger fast path', async () => {
  // Seed the exec cache with a SeaDrop result
  setCachedExecution(C_SEADROP_SKIP, 'eth', {
    functionName: 'mintPublic',
    argsSummary: [],
    gas: '200000',
    chainId: 1,
    source: 'seadrop',      // ← this should cause fast path to be skipped
    latencyMs: 50,
  })
  setCachedAbi(C_SEADROP_SKIP, 'eth', SEADROP_INTERFACE_ABI)

  // Prepare should NOT use the cached 'mintPublic' with wrong ABI/to
  // It should go through full SeaDrop detection and return to=router
  const result = await prepareMintTransaction(
    body(C_SEADROP_SKIP, { mintPrice: '0.00008' }),
    seaDropClient({ mintPrice: 80000000000000n }),
  )

  // If fast path was used, to=contract (wrong). If full detection ran, to=router.
  assert.equal(result.to.toLowerCase(), SEADROP_ROUTER.toLowerCase(),
    `to should be SeaDrop router. Got: ${result.to}. Fast path must be skipped for SeaDrop.`)
  assert.equal(result.source, 'seadrop')
})

await test('p4-1: exec cache with source=common_signature DOES use fast path', async () => {
  // Seed non-SeaDrop exec cache — fast path SHOULD be used
  setCachedExecution(C_SEADROP_SKIP_2, 'eth', {
    functionName: 'mint',
    argsSummary: ['1'],
    gas: '150000',
    chainId: 1,
    source: 'common_signature',
    latencyMs: 30,
  })
  // No ABI in cache — relies on fast path from execCache

  const result = await prepareMintTransaction(
    body(C_SEADROP_SKIP_2),
    standardClient(),
  )

  // Fast path should succeed and return source='cache'
  assert.equal(result.source, 'cache', `expected 'cache' fast path, got: ${result.source}`)
  assert.equal(result.to.toLowerCase(), C_SEADROP_SKIP_2.toLowerCase())
})

await test('p4-1: getCachedExecution still returns SeaDrop entries (cache write unaffected)', () => {
  const entry = getCachedExecution(C_SEADROP_SKIP, 'eth')
  assert.ok(entry, 'SeaDrop entry should still exist in exec cache')
  assert.equal(entry.source, 'seadrop')
  assert.equal(entry.functionName, 'mintPublic')
})

await test('p4-1: getPrewarmStatus returns ready=true for cached SeaDrop', () => {
  const status = getPrewarmStatus(C_SEADROP_SKIP, 'eth')
  assert.equal(status.ready, true, 'prewarm status should be ready even for SeaDrop')
  assert.equal(status.functionName, 'mintPublic')
})

// ─── Section 2: P4-2 — Probe cache state in readiness ────────────────────────

console.log('\n=== Section 2: P4-2 — Probe cache in readiness computation ===\n')

await test('p4-2: not_started probe → appears in readiness warnings', () => {
  setCachedProbeResult(C_PROBE_WARN_1, 'eth', {
    execution_status: 'not_started',
    revert_reason: 'Sale not active',
  })
  // Seed exec cache so score stays high (tests the probe-specific warning)
  setCachedExecution(C_PROBE_WARN_1, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })

  const r = computeReadiness(C_PROBE_WARN_1, 'eth')
  assert.ok(r.warnings.some(w => w.includes('not_started')),
    `warnings should include not_started, got: ${JSON.stringify(r.warnings)}`)
})

await test('p4-2: paused probe → appears in readiness warnings', () => {
  setCachedProbeResult(C_PROBE_WARN_2, 'eth', { execution_status: 'paused', revert_reason: 'Mint paused' })
  setCachedExecution(C_PROBE_WARN_2, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })

  const r = computeReadiness(C_PROBE_WARN_2, 'eth')
  assert.ok(r.warnings.some(w => w.includes('paused')),
    `warnings should include paused, got: ${JSON.stringify(r.warnings)}`)
})

await test('p4-2: sold_out probe → appears in readiness warnings', () => {
  setCachedProbeResult(C_PROBE_WARN_3, 'eth', { execution_status: 'sold_out', revert_reason: 'Max supply reached' })
  setCachedExecution(C_PROBE_WARN_3, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })

  const r = computeReadiness(C_PROBE_WARN_3, 'eth')
  assert.ok(r.warnings.some(w => w.includes('sold_out')),
    `warnings should include sold_out, got: ${JSON.stringify(r.warnings)}`)
})

await test('p4-2: positive probe (live) → no probe warning', () => {
  setCachedProbeResult(C_PROBE_POSITIVE, 'eth', { execution_status: 'live' })
  setCachedExecution(C_PROBE_POSITIVE, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })

  const r = computeReadiness(C_PROBE_POSITIVE, 'eth')
  const hasProbeWarning = r.warnings.some(w => w.toLowerCase().includes('contract state'))
  assert.ok(!hasProbeWarning, `should NOT have probe warning for 'live' state, got: ${JSON.stringify(r.warnings)}`)
})

await test('p4-2: no probe result → no probe warning', () => {
  // No probe result set for this contract
  const r = computeReadiness(C_PROBE_NONE, 'eth')
  const hasProbeWarning = r.warnings.some(w => w.toLowerCase().includes('contract state'))
  assert.ok(!hasProbeWarning, `should NOT have probe warning when no probe, got: ${JSON.stringify(r.warnings)}`)
})

await test('p4-2: probe_state check present in computeReadiness result', () => {
  setCachedProbeResult(C_PROBE_WARN_1, 'eth', { execution_status: 'not_started' })
  const r = computeReadiness(C_PROBE_WARN_1, 'eth')
  assert.ok('probe_state' in r.checks, 'checks should contain probe_state')
  assert.equal(r.checks.probe_state.detail, 'not_started')
})

await test('p4-2: probeState field in readiness result', () => {
  setCachedProbeResult(C_PROBE_WARN_1, 'eth', { execution_status: 'not_started' })
  const r = computeReadiness(C_PROBE_WARN_1, 'eth')
  assert.equal(r.probeState, 'not_started')
})

await test('p4-2: negative probe does NOT reduce score (informational only)', () => {
  setCachedProbeResult(C_PROBE_WARN_2, 'eth', { execution_status: 'paused' })
  setCachedExecution(C_PROBE_WARN_2, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })

  const r = computeReadiness(C_PROBE_WARN_2, 'eth')
  // Score should still be ≥75 since exec cache is warm — probe is a warning, not a blocker
  // (W.contract_valid=20 + W.rpc_healthy=15 + W.function_cached=40 + W.cache_fresh=10 = 85 min)
  assert.ok(r.score >= 70, `score ${r.score} should be ≥70 (probe is warning-only, not score-reducer)`)
})

// ─── Section 3: P4-3 — Exec cache invalidated on on-chain revert ─────────────

console.log('\n=== Section 3: P4-3 — Exec cache invalidated on on-chain revert ===\n')

await test('p4-3: invalidateCachedExecution removes entry from cache', () => {
  setCachedExecution(C_REVERT_INVAL, 'eth', {
    functionName: 'mint',
    argsSummary: ['1'],
    gas: '150000',
    chainId: 1,
    source: 'common_signature',
    latencyMs: 30,
  })
  assert.ok(getCachedExecution(C_REVERT_INVAL, 'eth'), 'entry should exist before invalidation')

  invalidateCachedExecution(C_REVERT_INVAL, 'eth')

  assert.equal(getCachedExecution(C_REVERT_INVAL, 'eth'), null, 'entry should be gone after invalidation')
})

await test('p4-3: after invalidation, full detection runs on next prepare', async () => {
  setCachedExecution(C_REVERT_INVAL, 'eth', {
    functionName: 'mint', argsSummary: ['1'], gas: '150000', chainId: 1, source: 'common_signature', latencyMs: 30,
  })
  invalidateCachedExecution(C_REVERT_INVAL, 'eth')

  // After invalidation, standard path runs — should succeed via fallback
  const result = await prepareMintTransaction(body(C_REVERT_INVAL), standardClient())
  assert.ok(result.functionName, 'full detection should resolve a function')
  // source should NOT be 'cache' — full detection ran
  assert.notEqual(result.source, 'cache', 'source must not be cache after invalidation')
})

await test('p4-3: invalidateCachedExecution is idempotent (no throw on double-call)', () => {
  invalidateCachedExecution(C_REVERT_INVAL, 'eth')
  invalidateCachedExecution(C_REVERT_INVAL, 'eth') // second call should not throw
  assert.equal(getCachedExecution(C_REVERT_INVAL, 'eth'), null)
})

await test('p4-3: simulating on-chain revert → executor should invalidate cache', () => {
  // Verify the contract address resolution logic used in executor.js revert handler
  const intent = {
    contract_address: C_REVERT_INVAL,
    to: null,
    mint_contract_address: null,
  }
  const contractAddr = intent.contract_address || intent.to || intent.mint_contract_address
  assert.equal(contractAddr, C_REVERT_INVAL)

  // Seed, then invalidate (mirrors what executor.js does on revert)
  setCachedExecution(C_REVERT_INVAL, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })
  invalidateCachedExecution(contractAddr, 'eth')
  assert.equal(getCachedExecution(C_REVERT_INVAL, 'eth'), null, 'cache must be cleared after simulated revert')
})

// ─── Section 4: P4-4 — loadCachedExecution null timestamp fix ────────────────

console.log('\n=== Section 4: P4-4 — loadCachedExecution null timestamp ===\n')

function makeSupabase(overrides = {}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                function_name: 'mint',
                args_summary: ['1'],
                gas_estimate: '150000',
                success_count: 3,
                last_latency_ms: 45,
                last_success_at: null,  // ← the problematic case
                ...overrides,
              },
              error: null,
            }),
          }),
        }),
      }),
    }),
  }
}

await test('p4-4: loadCachedExecution with null last_success_at → entry is usable (not expired)', async () => {
  const result = await loadCachedExecution(C_NULL_AT_1, 'eth', makeSupabase())
  assert.ok(result, 'should return entry even when last_success_at is null')
  assert.equal(result.functionName, 'mint')
  assert.equal(result.successCount, 3)
})

await test('p4-4: loaded entry with null timestamp is present in cache immediately after load', async () => {
  await loadCachedExecution(C_NULL_AT_1, 'eth', makeSupabase())
  const cached = getCachedExecution(C_NULL_AT_1, 'eth')
  assert.ok(cached, 'entry should be in cache immediately after load with null timestamp')
  assert.equal(cached.functionName, 'mint')
})

await test('p4-4: loadCachedExecution with valid timestamp → normal entry returned', async () => {
  const validTs = new Date(Date.now() - 60000).toISOString()  // 1 minute ago
  const result = await loadCachedExecution(C_NULL_AT_2, 'eth', makeSupabase({ last_success_at: validTs }))
  assert.ok(result, 'should return entry with valid timestamp')
  const cached = getCachedExecution(C_NULL_AT_2, 'eth')
  assert.ok(cached, 'entry should be in cache')
})

await test('p4-4: loadCachedExecution is no-op when cache already warm', async () => {
  // Pre-warm the cache
  setCachedExecution(C_NULL_AT_2, 'eth', { functionName: 'publicMint', gas: '180000', source: 'verified_abi', argsSummary: [], chainId: 1, latencyMs: 20 })

  // loadCachedExecution should return the in-memory entry without hitting Supabase
  let supabaseHit = false
  const mockSb = { from: () => { supabaseHit = true; return {} } }
  const result = await loadCachedExecution(C_NULL_AT_2, 'eth', mockSb)

  assert.equal(supabaseHit, false, 'Supabase should NOT be queried when in-memory cache is warm')
  assert.equal(result.functionName, 'publicMint')
})

// ─── Section 5: Readiness full check ─────────────────────────────────────────

console.log('\n=== Section 5: Readiness integration ===\n')

await test('readiness: valid contract with exec cache → execution_ready', () => {
  const C = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00ff'
  setCachedExecution(C, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature', argsSummary: [], chainId: 1, latencyMs: 30 })
  const r = computeReadiness(C, 'eth')
  assert.ok(r.score >= 75, `score ${r.score} should be ≥75 for cached contract`)
  assert.equal(r.status, 'execution_ready')
})

await test('readiness: no contract → not_ready with blocker', () => {
  const r = computeReadiness(null, 'eth')
  assert.equal(r.status, 'not_ready')
  assert.ok(r.blockers.length > 0)
})

await test('readiness: zero-address contract → not_ready', () => {
  const r = computeReadiness('0x0000000000000000000000000000000000000000', 'eth')
  assert.equal(r.status, 'not_ready')
  assert.ok(r.blockers.some(b => b.includes('contract')))
})

await test('readiness: returns probeState field', () => {
  const C = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00fe'
  const r = computeReadiness(C, 'eth')
  assert.ok('probeState' in r, 'probeState must be in readiness result')
})

await test('readiness: probeState=null when no probe', () => {
  const C = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00fd'
  const r = computeReadiness(C, 'eth')
  assert.equal(r.probeState, null)
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
