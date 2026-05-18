/**
 * Simulation executor tests.
 * Run: node worker/test/sim-executor.test.js
 *
 * Covers:
 *  - simulateArmedIntent: success path, claim race, replay persistence
 *  - runSimulationRequeueSweep: auto-requeue below MAX_AUTO_REQUEUES
 */

import assert from 'assert/strict'
import { simulateArmedIntent, runSimulationRequeueSweep } from '../lib/sim-executor.js'
import { INTENT_STATES } from '../lib/queue.js'

// ─── Mock Supabase ────────────────────────────────────────────────────────────

function createMockSupabase(rows = []) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  const eventLog = []

  function queryBuilder(table) {
    const _eqFilters = []
    const _inFilters = []
    const _ltFilters = []
    let _update = null
    let _insert = null

    function matchesRow(row) {
      if (!_eqFilters.every(([k, v]) => row[k] === v)) return false
      if (!_inFilters.every(([k, vals]) => vals.includes(row[k]))) return false
      if (!_ltFilters.every(([k, v]) => row[k] < v)) return false
      return true
    }

    const qb = {
      select(_cols) { return qb },
      eq(k, v) { _eqFilters.push([k, v]); return qb },
      in(k, vals) { _inFilters.push([k, vals]); return qb },
      lt(k, v) { _ltFilters.push([k, v]); return qb },
      or(_e) { return qb },
      not(_k, _op, _v) { return qb },
      gt(_k, _v) { return qb },
      lte(_k, _v) { return qb },
      order(_col, _opts) { return qb },
      limit(_n) { return qb },

      update(patch) { _update = patch; return qb },
      insert(data) { _insert = data; return qb },

      throwOnError() {
        if (_update && table === 'mint_intents') {
          for (const [, row] of store) {
            if (matchesRow(row)) Object.assign(row, _update)
          }
        }
        if (_insert && table === 'mint_execution_events') {
          const items = Array.isArray(_insert) ? _insert : [_insert]
          eventLog.push(...items)
        }
        return Promise.resolve({ data: null, error: null })
      },

      single() {
        if (_update) {
          for (const [, row] of store) {
            if (matchesRow(row)) {
              Object.assign(row, _update)
              return Promise.resolve({ data: { ...row }, error: null })
            }
          }
          return Promise.resolve({ data: null, error: null })
        }
        const rows = [...store.values()].filter(matchesRow)
        return Promise.resolve({ data: rows[0] ?? null, error: null })
      },

      catch() { return Promise.resolve(null) },

      then(resolve) {
        const rows = [...store.values()].filter(matchesRow)
        resolve({ data: rows, error: null })
      },
    }
    return qb
  }

  return {
    from: (table) => queryBuilder(table),
    store,
    eventLog,
  }
}

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

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nsim-executor.test.js\n')

// ── simulateArmedIntent: success path ─────────────────────────────────────────
await test('simulateArmedIntent: returns result for armed+enabled intent', async () => {
  const intent = {
    id: 's1',
    user_id: 'u1',
    status: 'armed',
    strike_enabled: true,
    chain: 'eth',
    contract_address: '0x0000000000000000000000000000000000000001',
    mint_price: '0',
  }
  const db = createMockSupabase([intent])
  const outcome = await simulateArmedIntent(db, intent)
  assert.ok(outcome, 'expected a result')
  assert.ok(outcome.result, 'expected result.result')
  assert.equal(outcome.succeeded, true, 'expected simulation to pass with SUCCESS adapter')
})

await test('simulateArmedIntent: transitions intent to simulated_success', async () => {
  const intent = {
    id: 's2',
    user_id: 'u1',
    status: 'armed',
    strike_enabled: true,
    chain: 'eth',
    contract_address: '0x0000000000000000000000000000000000000002',
    mint_price: '0',
  }
  const db = createMockSupabase([intent])
  await simulateArmedIntent(db, intent)
  const row = db.store.get('s2')
  assert.equal(row.status, INTENT_STATES.SIM_SUCCESS)
  assert.equal(row.simulation_status, 'passed')
})

await test('simulateArmedIntent: persists timeline events to mint_execution_events', async () => {
  const intent = {
    id: 's3',
    user_id: 'u1',
    status: 'armed',
    strike_enabled: true,
    chain: 'eth',
    contract_address: '0x0000000000000000000000000000000000000003',
    mint_price: '0',
  }
  const db = createMockSupabase([intent])
  await simulateArmedIntent(db, intent)
  // Should have at minimum: sim_start + timeline events + summary event
  assert.ok(db.eventLog.length >= 3, `expected ≥3 events, got ${db.eventLog.length}`)
  const states = db.eventLog.map(e => e.state)
  assert.ok(states.includes('sim_start'), 'missing sim_start event')
  assert.ok(
    states.includes(INTENT_STATES.SIM_SUCCESS) || states.some(s => s === 'success'),
    'missing sim_success event',
  )
})

await test('simulateArmedIntent: returns null when intent already claimed (race)', async () => {
  const intent = {
    id: 's4',
    user_id: 'u1',
    status: INTENT_STATES.EXECUTING_SIM, // already executing
    strike_enabled: true,
    chain: 'eth',
  }
  const db = createMockSupabase([intent])
  const result = await simulateArmedIntent(db, intent)
  assert.equal(result, null, 'should return null when claim fails')
})

await test('simulateArmedIntent: returns null when strike_enabled is false', async () => {
  const intent = {
    id: 's5',
    user_id: 'u1',
    status: 'armed',
    strike_enabled: false,
    chain: 'eth',
  }
  const db = createMockSupabase([intent])
  const result = await simulateArmedIntent(db, intent)
  assert.equal(result, null, 'should return null when strike_enabled=false')
})

await test('simulateArmedIntent: double-claim returns null second time', async () => {
  const intent = {
    id: 's6',
    user_id: 'u1',
    status: 'armed',
    strike_enabled: true,
    chain: 'eth',
    contract_address: '0x0000000000000000000000000000000000000006',
    mint_price: '0',
  }
  const db = createMockSupabase([intent])
  const first = await simulateArmedIntent(db, intent)
  assert.ok(first, 'first claim should succeed')
  const second = await simulateArmedIntent(db, { ...intent })
  assert.equal(second, null, 'second claim should fail (intent is now executing_simulation/done)')
})

// ── runSimulationRequeueSweep ─────────────────────────────────────────────────
await test('runSimulationRequeueSweep: requeues simulated_failure intents to armed', async () => {
  const intent = {
    id: 'r1',
    user_id: 'u1',
    status: INTENT_STATES.SIM_FAILED,
    strike_enabled: true,
    sim_requeue_count: 0,
  }
  const db = createMockSupabase([intent])
  const count = await runSimulationRequeueSweep(db, 5)
  assert.ok(count >= 1, 'should requeue at least one intent')
  const row = db.store.get('r1')
  assert.equal(row.status, INTENT_STATES.ARMED, 'intent should be back to armed')
})

await test('runSimulationRequeueSweep: skips intents at max requeue count', async () => {
  const intent = {
    id: 'r2',
    user_id: 'u1',
    status: INTENT_STATES.SIM_FAILED,
    strike_enabled: true,
    sim_requeue_count: 3, // at MAX_AUTO_REQUEUES
  }
  const db = createMockSupabase([intent])
  const count = await runSimulationRequeueSweep(db, 5)
  assert.equal(count, 0, 'should not requeue intent at max retries')
  const row = db.store.get('r2')
  assert.equal(row.status, INTENT_STATES.SIM_FAILED, 'intent should remain in sim_failed')
})

await test('runSimulationRequeueSweep: returns 0 when no failed intents', async () => {
  const db = createMockSupabase([
    { id: 'r3', status: 'armed', strike_enabled: true, user_id: 'u1' },
  ])
  const count = await runSimulationRequeueSweep(db, 5)
  assert.equal(count, 0)
})

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
