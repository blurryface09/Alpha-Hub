/**
 * Queue engine tests.
 * Run: node worker/test/queue.test.js
 *
 * Covers:
 *  - State constants
 *  - Invalid transition detection (no DB needed)
 *  - claimIntent: success, duplicate-claim prevention, wrong-state guard
 *  - markExpired: status update + event insertion
 *  - fetchReadyIntents: timing filter
 */

import assert from 'assert/strict'
import {
  INTENT_STATES,
  claimIntent,
  transitionIntent,
  markExpired,
  fetchReadyIntents,
  fetchPrewarmIntents,
} from '../lib/queue.js'

// ─── Minimal mock Supabase ────────────────────────────────────────────────────
// Implements just enough of the fluent query builder to satisfy queue.js calls.

function createMockSupabase(rows = []) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  const eventLog = []

  function queryBuilder(table) {
    // Captured state for this query chain
    const _eqFilters = []
    const _inFilters = []
    const _gtFilters = []
    const _lteFilters = []
    let _update = null
    let _insert = null
    let _orFilter = null
    let _limit = null

    function matchesRow(row) {
      if (!_eqFilters.every(([k, v]) => row[k] === v)) return false
      if (!_inFilters.every(([k, vals]) => vals.includes(row[k]))) return false
      if (!_gtFilters.every(([k, v]) => row[k] > v)) return false
      if (!_lteFilters.every(([k, v]) => row[k] <= v)) return false
      // Simplified OR: if there's a ".or" filter, skip row-level OR — let all pass
      // (tests don't rely on OR filtering for queue tests)
      return true
    }

    const qb = {
      select(_cols) { return qb },
      eq(k, v) { _eqFilters.push([k, v]); return qb },
      in(k, vals) { _inFilters.push([k, vals]); return qb },
      not(_k, _op, _v) { return qb },
      gt(k, v) { _gtFilters.push([k, v]); return qb },
      lte(k, v) { _lteFilters.push([k, v]); return qb },
      or(expr) { _orFilter = expr; return qb },
      order(_col, _opts) { return qb },
      limit(n) { _limit = n; return qb },

      update(patch) {
        _update = patch
        return qb
      },

      insert(data) {
        _insert = data
        return qb
      },

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
          // Atomic update: find first matching row, update it, return it
          for (const [, row] of store) {
            if (matchesRow(row)) {
              Object.assign(row, _update)
              return Promise.resolve({ data: { ...row }, error: null })
            }
          }
          // No match (race condition / wrong state)
          return Promise.resolve({ data: null, error: null })
        }
        // Select single
        const rows = [...store.values()].filter(matchesRow)
        return Promise.resolve({ data: rows[0] ?? null, error: null })
      },

      then(resolve) {
        let rows = [...store.values()].filter(matchesRow)

        // Simplified OR handling: if strike_execute_at is null OR <= now,
        // include rows with null strike_execute_at too (for fetchReadyIntents)
        if (_orFilter && _orFilter.includes('strike_execute_at.is.null')) {
          rows = [...store.values()].filter(r => {
            if (!_eqFilters.every(([k, v]) => r[k] === v)) return false
            if (!_inFilters.every(([k, vals]) => vals.includes(r[k]))) return false
            if (r.strike_execute_at === null) return true
            // Check lte part
            const cutoff = _orFilter.match(/strike_execute_at\.lte\.(.+)/)?.[1]
            if (cutoff && r.strike_execute_at <= cutoff) return true
            return false
          })
        }

        if (_limit) rows = rows.slice(0, _limit)
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

console.log('\nqueue.test.js\n')

// ── State constants ───────────────────────────────────────────────────────────
await test('INTENT_STATES contains all expected keys', () => {
  const required = ['PENDING', 'ARMED', 'QUEUED', 'EXECUTING', 'RETRYING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED']
  for (const key of required) {
    assert.ok(key in INTENT_STATES, `missing key: ${key}`)
    assert.equal(typeof INTENT_STATES[key], 'string')
  }
})

await test('INTENT_STATES values are unique strings', () => {
  const values = Object.values(INTENT_STATES)
  const unique = new Set(values)
  assert.equal(unique.size, values.length, 'duplicate state values detected')
})

// ── transitionIntent: validation (no DB) ─────────────────────────────────────
await test('transitionIntent throws on invalid transition: armed → retrying', async () => {
  // armed allows: queued, executing, executing_sim, cancelled, expired — not retrying directly
  await assert.rejects(
    () => transitionIntent(null, 'x', INTENT_STATES.ARMED, INTENT_STATES.RETRYING),
    /Invalid intent state transition/,
  )
})

await test('transitionIntent throws on invalid transition: pending → executing', async () => {
  await assert.rejects(
    () => transitionIntent(null, 'x', INTENT_STATES.PENDING, INTENT_STATES.EXECUTING),
    /Invalid intent state transition/,
  )
})

await test('transitionIntent allows valid transition: armed → cancelled', async () => {
  const db = createMockSupabase([
    { id: 'i1', status: INTENT_STATES.ARMED, strike_enabled: true },
  ])
  const result = await transitionIntent(db, 'i1', INTENT_STATES.ARMED, INTENT_STATES.CANCELLED)
  assert.ok(result, 'expected a result object')
})

// ── claimIntent ───────────────────────────────────────────────────────────────
await test('claimIntent: claims armed+enabled intent, returns updated row', async () => {
  const db = createMockSupabase([
    { id: 'i2', status: 'armed', strike_enabled: true, user_id: 'u1' },
  ])
  const result = await claimIntent(db, 'i2')
  assert.ok(result, 'expected a claimed intent')
  assert.equal(result.status, INTENT_STATES.EXECUTING)
})

await test('claimIntent: returns null when intent already executing (race)', async () => {
  const db = createMockSupabase([
    { id: 'i3', status: INTENT_STATES.EXECUTING, strike_enabled: true, user_id: 'u1' },
  ])
  const result = await claimIntent(db, 'i3')
  assert.equal(result, null, 'should return null for already-executing intent')
})

await test('claimIntent: returns null when strike_enabled is false', async () => {
  const db = createMockSupabase([
    { id: 'i4', status: 'armed', strike_enabled: false, user_id: 'u1' },
  ])
  const result = await claimIntent(db, 'i4')
  assert.equal(result, null)
})

await test('claimIntent: duplicate claim returns null second time', async () => {
  const db = createMockSupabase([
    { id: 'i5', status: 'armed', strike_enabled: true, user_id: 'u1' },
  ])
  const first = await claimIntent(db, 'i5')
  assert.ok(first, 'first claim should succeed')
  const second = await claimIntent(db, 'i5')
  assert.equal(second, null, 'second claim should fail (intent is now executing)')
})

// ── markExpired ───────────────────────────────────────────────────────────────
await test('markExpired: updates status to expired and inserts event', async () => {
  const intent = { id: 'i6', user_id: 'u1', status: 'armed', strike_enabled: true }
  const db = createMockSupabase([intent])
  await markExpired(db, intent)
  const row = db.store.get('i6')
  assert.equal(row.status, INTENT_STATES.EXPIRED)
  assert.equal(row.strike_enabled, false)
  assert.ok(db.eventLog.some(e => e.state === INTENT_STATES.EXPIRED))
})

// ── fetchReadyIntents ─────────────────────────────────────────────────────────
await test('fetchReadyIntents: returns intents with null strike_execute_at', async () => {
  const nowIso = new Date().toISOString()
  const db = createMockSupabase([
    { id: 'r1', status: 'armed', strike_enabled: true, strike_execute_at: null, updated_at: nowIso },
    { id: 'r2', status: 'armed', strike_enabled: false, strike_execute_at: null, updated_at: nowIso },
  ])
  const results = await fetchReadyIntents(db, 10, Date.now())
  const ids = results.map(r => r.id)
  assert.ok(ids.includes('r1'), 'should include enabled intent with null execute_at')
  assert.ok(!ids.includes('r2'), 'should exclude disabled intent')
})

await test('fetchReadyIntents: respects batchSize limit', async () => {
  const nowIso = new Date().toISOString()
  const intents = Array.from({ length: 10 }, (_, i) => ({
    id: `b${i}`,
    status: 'armed',
    strike_enabled: true,
    strike_execute_at: null,
    updated_at: nowIso,
  }))
  const db = createMockSupabase(intents)
  const results = await fetchReadyIntents(db, 3, Date.now())
  assert.equal(results.length, 3)
})

// ── fetchPrewarmIntents ───────────────────────────────────────────────────────
await test('fetchPrewarmIntents: returns only intents within prewarm window', async () => {
  const now = Date.now()
  const inWindow = new Date(now + 15_000).toISOString()   // 15s ahead (in 30s window)
  const tooFar = new Date(now + 120_000).toISOString()    // 2min ahead (outside)
  const past = new Date(now - 1_000).toISOString()        // already past

  const db = createMockSupabase([
    { id: 'p1', status: 'armed', strike_enabled: true, strike_execute_at: inWindow },
    { id: 'p2', status: 'armed', strike_enabled: true, strike_execute_at: tooFar },
    { id: 'p3', status: 'armed', strike_enabled: true, strike_execute_at: past },
  ])
  const results = await fetchPrewarmIntents(db, 30_000, now)
  const ids = results.map(r => r.id)
  assert.ok(ids.includes('p1'), 'should include intent in prewarm window')
  assert.ok(!ids.includes('p2'), 'should exclude intent too far in future')
  assert.ok(!ids.includes('p3'), 'should exclude past intent')
})

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
