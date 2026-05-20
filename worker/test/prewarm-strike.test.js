/**
 * Strike prewarm integration test harness.
 * Run: node worker/test/prewarm-strike.test.js
 *
 * Tests:
 *  - prewarmIntent: no contract address
 *  - prewarmIntent: cache hit short-circuits prepare call
 *  - prewarmIntent: successful cold prewarm persists call_data + gas_limit
 *  - prewarmIntent: uses resolved vault wallet address
 *  - prewarmIntent: falls back to placeholder when vault lookup fails
 *  - prewarmIntent: prepare failure returns ok=false without throwing
 *  - prewarmIntent: call_data + gas_limit written to intent row
 *  - prewarmIntent: mint_execution_events prewarm record inserted
 *  - prewarmIntent: returns latencyMs and confidence
 *  - prewarmIntent: already-cached intent skips prepare entirely
 *  - Queue behavior: multiple intents prewarmed independently
 *  - Timing: prewarm completes within reasonable budget
 */

import assert from 'assert/strict'
import { prewarmIntent } from '../lib/prewarmer.js'
import { setCachedExecution, getPrewarmStatus } from '../../api/_lib/contract-cache.js'

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONTRACT  = '0xabababababababababababababababababababababab'
const CONTRACT2 = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
const CONTRACT3 = '0xefefefefefefefefefefefefefefefefefefefef'
const WALLET    = '0x1111111111111111111111111111111111111111'
const VAULT_ADDR = '0x2222222222222222222222222222222222222222'

function makeIntent(overrides = {}) {
  return {
    id: 'intent-001',
    user_id: 'user-001',
    chain: 'eth',
    contract_address: CONTRACT,
    vault_wallet_id: null,
    max_mint_price: '0',
    mint_price: '0',
    quantity: 1,
    max_total_spend: null,
    strike_execute_at: new Date(Date.now() + 25000).toISOString(),
    ...overrides,
  }
}

// Supabase that returns a vault wallet row
function makeSupabase({ vaultAddress = VAULT_ADDR, updateFails = false, insertFails = false } = {}) {
  const updates = []
  const inserts = []

  const sb = {
    _updates: updates,
    _inserts: inserts,
    from(table) {
      if (table === 'alpha_vault_wallets') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: vaultAddress ? { address: vaultAddress } : null,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'mint_intents') {
        return {
          update(row) {
            updates.push(row)
            return {
              eq: () => ({
                catch: (fn) => updateFails ? fn(new Error('update failed')) : Promise.resolve(),
              }),
            }
          },
        }
      }
      if (table === 'mint_execution_events') {
        return {
          insert(row) {
            inserts.push(row)
            return {
              catch: (fn) => insertFails ? fn(new Error('insert failed')) : Promise.resolve(),
            }
          },
        }
      }
      return { from: () => sb }
    },
  }

  return sb
}

// Supabase where vault lookup throws
const vaultFailSupabase = {
  _updates: [],
  _inserts: [],
  from(table) {
    if (table === 'alpha_vault_wallets') {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => { throw new Error('network error') } }) }) }) }),
        }),
      }
    }
    return {
      update: () => ({ eq: () => ({ catch: () => Promise.resolve() }) }),
      insert: () => ({ catch: () => Promise.resolve() }),
    }
  },
}

// Mock prepareMintTransaction that always succeeds
function mockPrepare({ functionName = 'mint', gas = '150000', data = '0xabcd1234', cacheHit = false, source = 'common_signature' } = {}) {
  return async () => ({ functionName, gas, data, cacheHit, source })
}

// Mock prepareMintTransaction that always throws
function mockPrepareFail(message = 'RPC unavailable') {
  return async () => { throw new Error(message) }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n--- No contract address ---\n')

await test('returns ok=false with error=no_contract when contract_address missing', async () => {
  const intent = makeIntent({ contract_address: null, mint_contract_address: null })
  const result = await prewarmIntent(null, intent)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no_contract')
})

await test('uses mint_contract_address fallback when contract_address is null', async () => {
  const intent = makeIntent({ contract_address: null, mint_contract_address: CONTRACT2 })
  const sb = makeSupabase()
  const result = await prewarmIntent(sb, intent, { _prepareFn: mockPrepare() })
  assert.equal(result.ok, true)
})

console.log('\n--- Cache hit ---\n')

await test('returns cacheHit=true without calling prepare when contract already cached', async () => {
  const CACHED_C = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0'
  setCachedExecution(CACHED_C, 'eth', {
    functionName: 'publicMint', argsSummary: ['1'], gas: '160000', chainId: 1, source: 'common_signature', latencyMs: 300,
  })
  const intent = makeIntent({ contract_address: CACHED_C })
  let prepareCalled = false
  const result = await prewarmIntent(null, intent, {
    _prepareFn: async () => { prepareCalled = true; return {} },
  })
  assert.equal(result.ok, true)
  assert.equal(result.cacheHit, true)
  assert.equal(result.functionName, 'publicMint')
  assert.equal(prepareCalled, false, 'prepare should NOT be called on cache hit')
})

await test('confidence returned on cache hit', async () => {
  const CACHED_C = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0'
  const result = await prewarmIntent(null, makeIntent({ contract_address: CACHED_C }), {
    _prepareFn: async () => { throw new Error('should not be called') },
  })
  assert.ok(typeof result.confidence === 'number' && result.confidence > 0)
})

console.log('\n--- Successful cold prewarm ---\n')

await test('ok=true with functionName and latencyMs on success', async () => {
  const sb = makeSupabase()
  const result = await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT }), {
    _prepareFn: mockPrepare({ functionName: 'mint' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.functionName, 'mint')
  assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0)
  assert.ok(typeof result.confidence === 'number')
})

await test('call_data and gas_limit written to mint_intents row', async () => {
  const sb = makeSupabase()
  await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT }), {
    _prepareFn: mockPrepare({ functionName: 'mint', gas: '150000', data: '0xdeadbeef' }),
  })
  assert.ok(sb._updates.length > 0, 'should have called update on mint_intents')
  const update = sb._updates[sb._updates.length - 1]
  assert.equal(update.call_data, '0xdeadbeef')
  assert.equal(update.gas_limit, '150000')
  assert.ok(update.last_state?.includes('Prewarmed'))
})

await test('mint_execution_events prewarm record inserted', async () => {
  const sb = makeSupabase()
  const intent = makeIntent({ contract_address: CONTRACT })
  await prewarmIntent(sb, intent, {
    _prepareFn: mockPrepare({ functionName: 'mint' }),
  })
  assert.ok(sb._inserts.length > 0, 'should have inserted prewarm event')
  const event = sb._inserts[sb._inserts.length - 1]
  assert.equal(event.intent_id, intent.id)
  assert.equal(event.user_id, intent.user_id)
  assert.equal(event.state, 'prewarm')
  assert.ok(event.message?.includes('mint'))
  assert.ok(event.metadata?.fn)
})

console.log('\n--- Wallet resolution ---\n')

await test('uses resolved vault address in prepare call', async () => {
  const sb = makeSupabase({ vaultAddress: VAULT_ADDR })
  let usedWallet = null
  await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT }), {
    _prepareFn: async (params) => { usedWallet = params.walletAddress; return { functionName: 'mint', gas: '150000', data: '0x', cacheHit: false, source: 'common_signature' } },
  })
  assert.equal(usedWallet, VAULT_ADDR)
})

await test('falls back to placeholder when vault lookup throws', async () => {
  let usedWallet = null
  await prewarmIntent(vaultFailSupabase, makeIntent({ contract_address: CONTRACT2 }), {
    _prepareFn: async (params) => { usedWallet = params.walletAddress; return { functionName: 'mint', gas: '150000', data: '0x', cacheHit: false, source: 'common_signature' } },
  })
  assert.equal(usedWallet, '0x0000000000000000000000000000000000000001')
})

await test('uses opts.walletAddress override above vault lookup', async () => {
  const sb = makeSupabase({ vaultAddress: VAULT_ADDR })
  let usedWallet = null
  await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT }), {
    walletAddress: WALLET,
    _prepareFn: async (params) => { usedWallet = params.walletAddress; return { functionName: 'mint', gas: '150000', data: '0x', cacheHit: false, source: 'common_signature' } },
  })
  assert.equal(usedWallet, WALLET)
})

console.log('\n--- Prepare failure ---\n')

await test('returns ok=false without throwing when prepare throws', async () => {
  const sb = makeSupabase()
  const result = await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT3 }), {
    _prepareFn: mockPrepareFail('Simulated RPC timeout'),
  })
  assert.equal(result.ok, false)
  assert.ok(result.error?.includes('Simulated RPC timeout'))
})

await test('never throws — always returns result object', async () => {
  const result = await prewarmIntent(null, makeIntent({ contract_address: CONTRACT3 }), {
    _prepareFn: async () => { throw new Error('catastrophic failure') },
  })
  assert.ok(typeof result === 'object')
  assert.equal(typeof result.ok, 'boolean')
})

await test('DB write failure does not prevent ok=true result', async () => {
  const sb = makeSupabase({ updateFails: true, insertFails: true })
  const result = await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT }), {
    _prepareFn: mockPrepare({ functionName: 'mint' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.functionName, 'mint')
})

console.log('\n--- Queue behavior ---\n')

await test('multiple intents prewarmed independently', async () => {
  const intents = [
    makeIntent({ id: 'q-001', contract_address: '0xaaaa000000000000000000000000000000000001' }),
    makeIntent({ id: 'q-002', contract_address: '0xaaaa000000000000000000000000000000000002' }),
    makeIntent({ id: 'q-003', contract_address: '0xaaaa000000000000000000000000000000000003' }),
  ]
  const sb = makeSupabase()
  const results = await Promise.all(intents.map(intent =>
    prewarmIntent(sb, intent, { _prepareFn: mockPrepare({ functionName: 'mint' }) }),
  ))
  assert.ok(results.every(r => r.ok === true), 'all intents should prewarm successfully')
  assert.ok(new Set(results.map(r => r.functionName)).size === 1, 'same function detected for all')
})

await test('one failing intent does not block others', async () => {
  let callCount = 0
  const intents = [
    makeIntent({ id: 'qf-001', contract_address: '0xbbbb000000000000000000000000000000000001' }),
    makeIntent({ id: 'qf-002', contract_address: '0xbbbb000000000000000000000000000000000002' }),
  ]
  const sb = makeSupabase()
  const results = await Promise.all(intents.map((intent, i) =>
    prewarmIntent(sb, intent, {
      _prepareFn: async () => {
        callCount++
        if (i === 0) throw new Error('first intent fails')
        return { functionName: 'mint', gas: '150000', data: '0x', cacheHit: false, source: 'common_signature' }
      },
    }),
  ))
  assert.equal(results[0].ok, false)
  assert.equal(results[1].ok, true)
  assert.equal(callCount, 2)
})

console.log('\n--- Timing ---\n')

await test('prewarm completes under 100ms with mock prepare', async () => {
  const sb = makeSupabase()
  const t0 = Date.now()
  await prewarmIntent(sb, makeIntent({ contract_address: CONTRACT }), {
    _prepareFn: mockPrepare(),
  })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 100, `prewarm took ${elapsed}ms, expected < 100ms`)
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
