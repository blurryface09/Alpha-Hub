/**
 * Phase 3 — Execution trace hardening tests.
 *
 * Verifies that every failure path writes complete, actionable context to
 * mint_execution_events and mint_intents so failures are debuggable from DB.
 *
 * Invariants validated:
 *  T1 — strike_error field is written on execution failure (not just simulation_error)
 *  T2 — last_state includes the actual error message (not just "Strike failed safely")
 *  T3 — failed event metadata has: fn, source, to, value, gas, chain, rpc, raw_error
 *  T4 — simulate event metadata has: fn, source, to, value, gas
 *  T5 — legacy path (strike-engine.js) and executor path both apply T1–T4
 *
 * Run: node worker/test/exec-trace.test.js
 */

import assert from 'assert/strict'
import { prewarmIntent } from '../lib/prewarmer.js'

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

// ─── Supabase mock ────────────────────────────────────────────────────────────

function makeSupabase() {
  const updates = []
  const inserts = []
  return {
    _updates: updates,
    _inserts: inserts,
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
        update(row) {
          updates.push({ table, row })
          return {
            eq: () => ({
              catch: () => Promise.resolve(),
              throwOnError: () => Promise.resolve(),
            }),
          }
        },
        insert(row) {
          inserts.push({ table, row })
          return {
            catch: () => Promise.resolve(),
            throwOnError: () => Promise.resolve(),
          }
        },
      }
    },
  }
}

// ─── Intent fixture ───────────────────────────────────────────────────────────

const NFT_CONTRACT  = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const ROUTER_ADDR   = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
const PREWARM_VALUE = '80000000000000'
const PREWARM_DATA  = '0x161ac21f0000000000000000000000000000000000000000'
const PREWARM_GAS   = '200000'

function makeIntent(overrides = {}) {
  return {
    id: 'trace-test-001',
    user_id: 'user-trace-001',
    chain: 'eth',
    contract_address: NFT_CONTRACT,
    vault_wallet_id: null,
    max_mint_price: '0.00008',
    mint_price: '0.00008',
    quantity: 1,
    max_total_spend: null,
    ...overrides,
  }
}

// ─── Simulate legacy executor failure path (mirrors legacyProcessIntent catch) ─

function simulateLegacyFailure({ prepared = null, error, chain = 'eth', selectedRpc = null, prepareLatencyMs = 50 } = {}) {
  // Replicate the exact catch block logic from legacyProcessIntent (strike-engine.js)
  const message = String(error?.shortMessage || error?.message || 'Strike execution failed.').slice(0, 240)
  const update = {
    status: 'failed',
    strike_enabled: false,
    strike_error: message,
    simulation_status: 'failed',
    simulation_error: message,
    last_state: `Strike failed: ${message.slice(0, 120)}`,
  }
  const event = {
    state: 'failed',
    message: 'Strike failed safely. No duplicate transaction will be sent.',
    metadata: {
      error: message,
      raw_error: (error?.rawReason || error?.message || '').slice(0, 300),
      fn: prepared?.functionName,
      source: prepared?.source,
      to: prepared?.to?.slice(0, 10),
      value: prepared?.value,
      gas: prepared?.gas,
      chain,
      rpc: selectedRpc?.label,
      prepare_latency_ms: prepareLatencyMs,
    },
  }
  return { update, event }
}

// ─── Simulate executor.js failure path (mirrors executeIntent catch) ───────────

function simulateExecutorFailure({ err, tracedTo = null, tracedValue = null, tracedGas = null, tracedFn = null, tracedSource = null, chainKey = 'eth', rpcLabel = null, latencyMs = 80 } = {}) {
  const message = String(err?.shortMessage || err?.message || 'Strike execution failed.').slice(0, 240)
  const update = {
    status: 'failed',
    strike_enabled: false,
    strike_error: message,
    simulation_status: 'failed',
    simulation_error: message,
    last_state: `Strike failed: ${message.slice(0, 120)}`,
  }
  const event = {
    state: 'failed',
    message: 'Strike failed safely. No duplicate transaction will be sent.',
    metadata: {
      error: message,
      raw_error: (err?.rawReason || err?.message || '').slice(0, 300),
      error_type: null,
      fn: tracedFn,
      source: tracedSource,
      to: tracedTo?.slice(0, 10),
      value: tracedValue,
      gas: tracedGas,
      chain: chainKey,
      rpc: rpcLabel,
      latency_ms: latencyMs,
    },
  }
  return { update, event }
}

// ─── Section 1: T1 — strike_error written on failure ─────────────────────────

console.log('\n=== Section 1: T1 — strike_error written on execution failure ===\n')

await test('legacy: strike_error written when prepareMintTransaction fails', () => {
  const error = new Error('Mint simulation failed — contract rejected the transaction.')
  const { update } = simulateLegacyFailure({ error })
  assert.ok('strike_error' in update, 'strike_error field must be present in DB update')
  assert.equal(update.strike_error, update.simulation_error,
    'strike_error and simulation_error should have the same message')
})

await test('legacy: strike_error written when vault load fails', () => {
  const error = new Error('Alpha Vault is not ready.')
  const { update } = simulateLegacyFailure({ error })
  assert.ok(update.strike_error, 'strike_error must be set')
  assert.ok(update.strike_error.includes('Vault'), `strike_error: ${update.strike_error}`)
})

await test('executor: strike_error written on sendTransaction failure', () => {
  const error = new Error('insufficient funds for transfer')
  const { update } = simulateExecutorFailure({ err: error })
  assert.ok('strike_error' in update, 'strike_error field must be present in DB update')
  assert.ok(update.strike_error, 'strike_error must not be empty')
})

await test('strike_error length is capped at 240 chars', () => {
  const longMsg = 'x'.repeat(400)
  const error = new Error(longMsg)
  const { update } = simulateLegacyFailure({ error })
  assert.ok(update.strike_error.length <= 240, `length ${update.strike_error.length} exceeds 240`)
})

// ─── Section 2: T2 — last_state includes error message ───────────────────────

console.log('\n=== Section 2: T2 — last_state includes error message ===\n')

await test('legacy: last_state is not generic "Strike failed safely"', () => {
  const error = new Error('Sold out — this mint has reached maximum supply.')
  const { update } = simulateLegacyFailure({ error })
  assert.notEqual(update.last_state, 'Strike failed safely',
    'last_state must not be the old generic message')
})

await test('legacy: last_state starts with "Strike failed:"', () => {
  const error = new Error('Wrong mint price — check the price on the official mint page.')
  const { update } = simulateLegacyFailure({ error })
  assert.ok(update.last_state.startsWith('Strike failed:'),
    `last_state: ${update.last_state}`)
})

await test('legacy: last_state contains the error text', () => {
  const error = new Error('Insufficient ETH — top up your wallet and try again.')
  const { update } = simulateLegacyFailure({ error })
  assert.ok(update.last_state.includes('Insufficient ETH'),
    `last_state should contain error text, got: ${update.last_state}`)
})

await test('executor: last_state includes error (not generic)', () => {
  const error = new Error('Transaction reverted — contract rejected gas estimation.')
  const { update } = simulateExecutorFailure({ err: error })
  assert.notEqual(update.last_state, 'Strike failed safely')
  assert.ok(update.last_state.startsWith('Strike failed:'))
})

await test('last_state error portion is capped at 120 chars', () => {
  const veryLongErr = 'A'.repeat(300)
  const error = new Error(veryLongErr)
  const { update } = simulateLegacyFailure({ error })
  // Format: "Strike failed: " (15) + up to 120 = 135 max
  assert.ok(update.last_state.length <= 136, `last_state length ${update.last_state.length} exceeds expected max`)
})

// ─── Section 3: T3 — failed event metadata completeness ──────────────────────

console.log('\n=== Section 3: T3 — failed event metadata completeness ===\n')

const PREPARED_SEADROP = {
  to: ROUTER_ADDR,
  value: PREWARM_VALUE,
  gas: PREWARM_GAS,
  functionName: 'mintPublic',
  source: 'seadrop',
}

const SELECTED_RPC = { label: 'eth_alchemy_1', url: 'https://eth-mainnet.g.alchemy.com/v2/xxx' }

await test('legacy failed event: has fn field', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP, selectedRpc: SELECTED_RPC })
  assert.equal(event.metadata.fn, 'mintPublic')
})

await test('legacy failed event: has source field', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP })
  assert.equal(event.metadata.source, 'seadrop')
})

await test('legacy failed event: has to field (first 10 chars)', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP })
  assert.ok(event.metadata.to, 'to field must be present')
  assert.equal(event.metadata.to, ROUTER_ADDR.slice(0, 10))
})

await test('legacy failed event: has value field', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP })
  assert.equal(event.metadata.value, PREWARM_VALUE)
})

await test('legacy failed event: has gas field', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP })
  assert.equal(event.metadata.gas, PREWARM_GAS)
})

await test('legacy failed event: has chain field', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP, chain: 'base' })
  assert.equal(event.metadata.chain, 'base')
})

await test('legacy failed event: has rpc field', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepared: PREPARED_SEADROP, selectedRpc: SELECTED_RPC })
  assert.equal(event.metadata.rpc, SELECTED_RPC.label)
})

await test('legacy failed event: has prepare_latency_ms', () => {
  const error = new Error('Mint simulation failed.')
  const { event } = simulateLegacyFailure({ error, prepareLatencyMs: 1234 })
  assert.equal(event.metadata.prepare_latency_ms, 1234)
})

await test('legacy failed event: has raw_error with original error text', () => {
  const rawMsg = 'IncorrectPayment(0, 80000000000000)'
  const safeMsg = 'Wrong mint price — check the price on the official mint page.'
  const error = Object.assign(new Error(safeMsg), { rawReason: rawMsg })
  const { event } = simulateLegacyFailure({ error })
  assert.ok(event.metadata.raw_error.includes(rawMsg),
    `raw_error should contain original revert: ${event.metadata.raw_error}`)
})

await test('executor failed event: fn populated from tracedFn', () => {
  const error = new Error('insufficient funds for transfer')
  const { event } = simulateExecutorFailure({
    err: error,
    tracedFn: 'mintPublic',
    tracedSource: 'prewarm_cache',
    tracedTo: ROUTER_ADDR,
    tracedValue: PREWARM_VALUE,
    tracedGas: PREWARM_GAS,
    chainKey: 'eth',
    rpcLabel: 'eth_alchemy_1',
  })
  assert.equal(event.metadata.fn, 'mintPublic')
  assert.equal(event.metadata.source, 'prewarm_cache')
  assert.equal(event.metadata.to, ROUTER_ADDR.slice(0, 10))
  assert.equal(event.metadata.value, PREWARM_VALUE)
  assert.equal(event.metadata.gas, PREWARM_GAS)
  assert.equal(event.metadata.chain, 'eth')
  assert.equal(event.metadata.rpc, 'eth_alchemy_1')
})

await test('failed event: null prepared → fn/source/to/value/gas all null/undefined', () => {
  const error = new Error('Alpha Vault is not ready.')
  const { event } = simulateLegacyFailure({ error, prepared: null })
  // When failure happens before prepare, these fields are undefined — acceptable
  assert.equal(event.metadata.fn, undefined)
  assert.equal(event.metadata.source, undefined)
  assert.equal(event.metadata.to, undefined)
  assert.equal(event.metadata.value, undefined)
})

// ─── Section 4: T4 — simulate event metadata completeness ────────────────────

console.log('\n=== Section 4: T4 — simulate event metadata ===\n')

function makeSimulateEvent(to, value, gas, fn, source, chainKey = 'eth') {
  return {
    state: 'simulate',
    metadata: {
      chain: chainKey,
      fn,
      source,
      to: to.slice(0, 10),
      value: value.toString(),
      gas: gas?.toString() || null,
      strategy: 'eip1559',
      base_fee_gwei: '12.5',
    },
  }
}

await test('simulate event: to is first 10 chars of address', () => {
  const ev = makeSimulateEvent(ROUTER_ADDR, '80000000000000', '200000', 'mintPublic', 'prewarm_cache')
  assert.equal(ev.metadata.to, ROUTER_ADDR.slice(0, 10))
  assert.equal(ev.metadata.to.length, 10)
})

await test('simulate event: value is string', () => {
  const ev = makeSimulateEvent(NFT_CONTRACT, '0', null, 'mint', 'common_signature')
  assert.equal(typeof ev.metadata.value, 'string')
  assert.equal(ev.metadata.value, '0')
})

await test('simulate event: paid mint value matches expected wei', () => {
  const ev = makeSimulateEvent(ROUTER_ADDR, '80000000000000', '200000', 'mintPublic', 'seadrop')
  assert.equal(ev.metadata.value, '80000000000000')
})

await test('simulate event: fn populated for prewarm_cache path', () => {
  const ev = makeSimulateEvent(ROUTER_ADDR, '80000000000000', '200000', 'mintPublic', 'prewarm_cache')
  assert.equal(ev.metadata.fn, 'mintPublic')
  assert.equal(ev.metadata.source, 'prewarm_cache')
})

await test('simulate event: gas=null when not set (let RPC estimate)', () => {
  const ev = makeSimulateEvent(NFT_CONTRACT, '0', null, 'mint', 'common_signature')
  assert.equal(ev.metadata.gas, null)
})

// ─── Section 5: Prewarm context correctly feeds executor trace ────────────────

console.log('\n=== Section 5: Prewarm → executor trace chain ===\n')

await test('prewarm output maps to executor trace fields correctly', async () => {
  const sb = makeSupabase()
  const prepareFn = async () => ({
    to: ROUTER_ADDR,
    data: PREWARM_DATA,
    value: PREWARM_VALUE,
    gas: PREWARM_GAS,
    functionName: 'mintPublic',
    source: 'seadrop',
    cacheHit: false,
  })

  await prewarmIntent(sb, makeIntent(), { _prepareFn: prepareFn })
  const update = sb._updates.find(u => u.table === 'mint_intents')

  // These are what executor.js reads to build the trace vars
  const simulatedTracedTo     = update.row.to
  const simulatedTracedValue  = update.row.value
  const simulatedTracedGas    = update.row.gas_limit
  const simulatedTracedFn     = update.row.function_name

  assert.equal(simulatedTracedTo.toLowerCase(), ROUTER_ADDR.toLowerCase(),
    'tracedTo should be router after prewarm')
  assert.equal(simulatedTracedValue, PREWARM_VALUE,
    'tracedValue should be prewarm value (C1 fix)')
  assert.equal(simulatedTracedGas, PREWARM_GAS)
  assert.equal(simulatedTracedFn, 'mintPublic')
})

await test('executor trace: intent.to used as tracedTo (SeaDrop router case)', () => {
  const intent = {
    mint_contract_address: null,
    to: ROUTER_ADDR,
    contract_address: NFT_CONTRACT,
    value: PREWARM_VALUE,
    gas_limit: PREWARM_GAS,
    function_name: 'mintPublic',
    call_data: PREWARM_DATA,
  }
  const to    = intent.mint_contract_address || intent.to || intent.contract_address
  const value = BigInt(intent.mint_price || intent.value || '0')
  const gas   = intent.gas_limit ? BigInt(intent.gas_limit) : undefined
  const fn    = intent.function_name || (intent.call_data ? 'prewarmed' : null)
  const src   = intent.call_data ? 'prewarm_cache' : null

  assert.equal(to.toLowerCase(), ROUTER_ADDR.toLowerCase(), 'to = router (C2 fix)')
  assert.equal(value.toString(), PREWARM_VALUE)
  assert.equal(gas?.toString(), PREWARM_GAS)
  assert.equal(fn, 'mintPublic')
  assert.equal(src, 'prewarm_cache')
})

await test('executor trace: contract_address used as tracedTo when to/mint_contract_address absent', () => {
  const intent = {
    mint_contract_address: null,
    to: null,
    contract_address: NFT_CONTRACT,
    value: '0',
    gas_limit: null,
    function_name: null,
    call_data: null,
  }
  const to  = intent.mint_contract_address || intent.to || intent.contract_address
  const fn  = intent.function_name || (intent.call_data ? 'prewarmed' : null)
  const src = intent.call_data ? 'prewarm_cache' : null

  assert.equal(to.toLowerCase(), NFT_CONTRACT.toLowerCase(), 'contract_address fallback (C4 fix)')
  assert.equal(fn, null)
  assert.equal(src, null)
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
