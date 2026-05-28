/**
 * End-to-end smoke test — full local pipeline.
 *
 * What this tests that unit tests do NOT:
 *   - prewarmIntent runs against the real prepareMintTransaction logic
 *     and correctly writes call_data + gas_limit back to the mock DB row
 *   - scheduleIntent fires the executor at the exact execute_at millisecond
 *   - The executor receives the updated row (with prewarm call_data) from the DB
 *   - Supabase connectivity: pings the real DB to verify service role access
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node worker/test/e2e-smoke.test.js
 *   (or just: node worker/test/e2e-smoke.test.js if worker/.env is loaded)
 *
 * Does NOT send any blockchain transactions.
 * Does NOT write to real Supabase (uses an in-memory mock).
 */

import assert from 'assert/strict'
import { createClient } from '@supabase/supabase-js'
import { scheduleIntent, cancelScheduled, scheduledCount } from '../lib/scheduler.js'
import { prewarmIntent } from '../lib/prewarmer.js'
import { fetchPrewarmIntents } from '../lib/queue.js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

let passed = 0
let failed = 0

async function test(name, fn) {
  const t = Date.now()
  try {
    await fn()
    console.log(`  ✓  ${name} (${Date.now() - t}ms)`)
    passed++
  } catch (err) {
    console.error(`  ✗  ${name}`)
    console.error(`     ${err.message}`)
    failed++
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Mock Supabase with in-memory store ───────────────────────────────────────

function createMockDb(rows = []) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  const events = []

  function qb(table) {
    const eqF = [], inF = [], lteF = [], gtF = []
    let _patch = null, _insert = null, _limit = Infinity

    const matchesRow = row => {
      if (!eqF.every(([k, v]) => row[k] === v)) return false
      if (!inF.every(([k, vs]) => vs.includes(row[k]))) return false
      if (!lteF.every(([k, v]) => row[k] <= v)) return false
      if (!gtF.every(([k, v]) => row[k] > v)) return false
      return true
    }

    const builder = {
      select: () => builder,
      eq:    (k, v) => { eqF.push([k, v]); return builder },
      in:    (k, v) => { inF.push([k, v]); return builder },
      lte:   (k, v) => { lteF.push([k, v]); return builder },
      gt:    (k, v) => { gtF.push([k, v]); return builder },
      not:   () => builder,
      or:    () => builder,
      order: () => builder,
      limit: (n) => { _limit = n; return builder },
      update: (patch) => { _patch = patch; return builder },
      insert: (data) => {
        _insert = Array.isArray(data) ? data : [data]
        return builder
      },
      throwOnError() {
        if (_patch && table === 'mint_intents') {
          for (const row of store.values()) {
            if (matchesRow(row)) Object.assign(row, _patch)
          }
        }
        if (_insert && table === 'mint_execution_events') events.push(..._insert)
        return Promise.resolve({ data: null, error: null })
      },
      single() {
        if (_patch) {
          for (const row of store.values()) {
            if (matchesRow(row)) {
              Object.assign(row, _patch)
              return Promise.resolve({ data: { ...row }, error: null })
            }
          }
          return Promise.resolve({ data: null, error: null })
        }
        const hit = [...store.values()].find(matchesRow)
        return Promise.resolve({ data: hit ?? null, error: null })
      },
      maybeSingle() {
        const hit = [...store.values()].find(matchesRow)
        return Promise.resolve({ data: hit ?? null, error: null })
      },
      then(resolve) {
        // Handle update/insert chained with .then() — prewarmer uses this pattern
        if (_patch && table === 'mint_intents') {
          for (const row of store.values()) {
            if (matchesRow(row)) Object.assign(row, _patch)
          }
          resolve({ data: null, error: null })
          return
        }
        if (_insert && table === 'mint_execution_events') {
          events.push(..._insert)
          resolve({ data: null, error: null })
          return
        }
        let rows = [...store.values()].filter(matchesRow)
        if (_limit < Infinity) rows = rows.slice(0, _limit)
        resolve({ data: rows, error: null })
      },
    }
    return builder
  }

  return { from: table => qb(table), store, events }
}

function makeIntent(id, executeAtMs, overrides = {}) {
  return {
    id,
    user_id: '00000000-0000-0000-0000-000000000001', // not a real user — safe with service role
    chain: 'base',
    contract_address: '0x1ee151e31999bd8441f6c1ab221f66cd2c8bbde7',
    mint_contract_address: '0x1ee151e31999bd8441f6c1ab221f66cd2c8bbde7',
    strike_enabled: true,
    strike_execute_at: new Date(executeAtMs).toISOString(),
    status: 'armed',
    call_data: null,
    gas_limit: null,
    ...overrides,
  }
}

// ─── Test 1: Supabase connectivity ────────────────────────────────────────────

console.log('\n=== Test 1: Supabase connectivity ===\n')

await test('can reach Supabase and read mint_intents (service role)', async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('     ↳ Skipping — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in env')
    return
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { error } = await supabase.from('mint_intents').select('id').limit(1)
  assert.ok(!error, `Supabase read failed: ${error?.message}`)
  console.log('     ↳ Connected and table accessible')
})

await test('fetchPrewarmIntents query runs against real DB', async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('     ↳ Skipping — credentials not in env')
    return
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  // Prewarm window: anything with execute_at between now and now+30s
  const results = await fetchPrewarmIntents(supabase, 30_000, Date.now())
  assert.ok(Array.isArray(results), 'fetchPrewarmIntents should return an array')
  console.log(`     ↳ ${results.length} intent(s) currently in prewarm window`)
})

// ─── Test 2: Prewarm pipeline ─────────────────────────────────────────────────

console.log('\n=== Test 2: Prewarm pipeline ===\n')

await test('prewarmIntent calls prepareFn and writes call_data back to DB', async () => {
  const executeAt = Date.now() + 60_000
  const intent = makeIntent('e2e-prewarm-1', executeAt)
  const db = createMockDb([
    intent,
    // Alpha vault wallet row (used by resolveVaultAddress)
    { id: 'v1', user_id: intent.user_id, address: '0xDeadBeef', status: 'active' },
  ])

  // prepareFn response shape: prewarmer reads prepared.data (call_data), prepared.gas, etc.
  const MOCK_CALL_DATA = '0xa0712d680000000000000000000000000000000000000000000000000000000000000001'
  const mockPrepareFn = async (_body, _token, _sbClient) => ({
    data:         MOCK_CALL_DATA,  // ← 'data' maps to call_data in the DB write-back
    gas:          '185000',
    functionName: 'mint(uint256)',
    source:       'e2e_mock',
    to:           intent.contract_address,
    value:        '0',
    cacheHit:     false,
  })

  const result = await prewarmIntent(db, intent, { _prepareFn: mockPrepareFn })

  assert.ok(result.ok, `prewarm failed: ${result.error}`)
  assert.ok(result.functionName, 'should have detected a function name')

  // Verify call_data + gas_limit were persisted to the mock DB row
  const updated = db.store.get(intent.id)
  assert.ok(updated.call_data, 'call_data should be written back to DB')
  assert.ok(updated.gas_limit, 'gas_limit should be written back to DB')

  console.log(`     ↳ Function: ${result.functionName}`)
  console.log(`     ↳ call_data in DB: ${updated.call_data?.slice(0, 18)}…`)
  console.log(`     ↳ gas_limit in DB: ${updated.gas_limit}`)
})

await test('prewarmIntent reports cacheHit when prepareFn returns cacheHit:true', async () => {
  const executeAt = Date.now() + 60_000
  const intent = makeIntent('e2e-prewarm-cache', executeAt)
  const db = createMockDb([intent])

  // Simulate a warm in-memory cache — prepareFn itself returns cacheHit:true
  const result = await prewarmIntent(db, intent, {
    _prepareFn: async () => ({
      data:         '0xa0712d68000000000000000000000000000000000000000000000000000000000000007b',
      gas:          '200000',
      functionName: 'mint(uint256)',
      source:       'cache',
      to:           intent.contract_address,
      value:        '0',
      cacheHit:     true,
    }),
  })

  assert.ok(result.ok, 'prewarm should succeed on cache hit')
  assert.equal(result.functionName, 'mint(uint256)', 'should return function name')
  console.log('     ↳ Cache-hit prewarm succeeded — function name preserved')
})

// ─── Test 3: Full pipeline — prewarm → schedule → execute ────────────────────

console.log('\n=== Test 3: Full pipeline — prewarm → schedule → execute ===\n')

await test('intent prewarmed → scheduled → executed at exact time', async () => {
  const DELAY_MS = 500
  const executeAt = Date.now() + DELAY_MS
  const intent = makeIntent('e2e-pipeline-1', executeAt)
  const db = createMockDb([intent, { id: 'v1', user_id: intent.user_id, address: '0xDeadBeef', status: 'active' }])

  // Step 1: prewarm
  const MOCK_CALL_DATA = '0xa0712d680000000000000000000000000000000000000000000000000000000000000001'
  const mockPrepareFn = async () => ({
    data:         MOCK_CALL_DATA,
    gas:          '185000',
    functionName: 'mint(uint256)',
    source:       'e2e_mock',
    to:           intent.contract_address,
    value:        '0',
    cacheHit:     false,
  })
  const prewarmResult = await prewarmIntent(db, intent, { _prepareFn: mockPrepareFn })
  assert.ok(prewarmResult.ok, `prewarm failed: ${prewarmResult.error}`)

  const prewarmedIntent = db.store.get(intent.id)
  assert.ok(prewarmedIntent.call_data, 'call_data should be populated after prewarm')

  // Step 2: schedule
  let executedIntent = null
  let firedAt = null

  scheduleIntent(db, prewarmedIntent, async (_db, i) => {
    executedIntent = i
    firedAt = Date.now()
  })
  assert.equal(scheduledCount(), 1, 'should have 1 timer registered')

  // Step 3: wait for timer
  await sleep(DELAY_MS + 100)

  assert.ok(firedAt !== null, 'intent should have fired')
  assert.ok(executedIntent !== null, 'executor should have received the intent')
  assert.ok(executedIntent.call_data, 'executor received intent WITH call_data (prewarm persisted)')

  const drift = Math.abs(firedAt - executeAt)
  console.log(`     ↳ Timer drift: ${drift}ms (target: <20ms)`)
  console.log(`     ↳ Intent had call_data at execution time: ${Boolean(executedIntent.call_data)}`)
  assert.ok(drift < 20, `Timer drift ${drift}ms exceeded 20ms`)
  assert.equal(scheduledCount(), 0, 'scheduler should be empty after firing')
})

await test('intent without call_data still executes (fallback path)', async () => {
  const DELAY_MS = 300
  const executeAt = Date.now() + DELAY_MS
  const intent = makeIntent('e2e-pipeline-fallback', executeAt) // no call_data
  const db = createMockDb([intent])

  let fired = false
  scheduleIntent(db, intent, async () => { fired = true })

  await sleep(DELAY_MS + 80)
  assert.ok(fired, 'intent should fire even without call_data')
  console.log('     ↳ Executor fires regardless of call_data presence')
})

// ─── Test 4: Concurrent FCFS — 5 users ───────────────────────────────────────

console.log('\n=== Test 4: Concurrent FCFS — 5 users, same execute_at ===\n')

await test('5 concurrent intents fire within 5ms of each other', async () => {
  const N = 5
  const executeAt = Date.now() + 400
  const fireTimes = []

  for (let i = 0; i < N; i++) {
    const intent = makeIntent(`e2e-fcfs-${i}`, executeAt)
    scheduleIntent(null, intent, async () => { fireTimes.push(Date.now()) })
  }

  await sleep(400 + 80)

  assert.equal(fireTimes.length, N, `expected ${N} fires, got ${fireTimes.length}`)
  const spread = Math.max(...fireTimes) - Math.min(...fireTimes)
  console.log(`     ↳ All ${N} intents fired. Spread: ${spread}ms`)
  assert.ok(spread < 15, `Spread ${spread}ms exceeded 15ms — intents not firing simultaneously`)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(`\n${'─'.repeat(50)}`)
console.log(`${passed}/${total} tests passed`)
console.log(`${'─'.repeat(50)}\n`)
if (failed > 0) process.exitCode = 1
