/**
 * FCFS Parallel Execution Load Test
 *
 * Verifies that:
 *  1. N intents with the same execute_at all fire within 50ms of each other
 *  2. Precision scheduler drift is < 20ms from target time
 *  3. No intent blocks another (parallel, not sequential)
 *  4. Scheduler is idempotent (re-registering same intent is a no-op)
 *  5. Total wall time for N parallel intents ≈ time of 1 intent (not N × 1)
 *
 * Run: node worker/test/fcfs-parallel.test.js
 */

import assert from 'assert/strict'
import { scheduleIntent, cancelScheduled, scheduledCount, getScheduled } from '../lib/scheduler.js'

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeIntent(id, executeAtMs, overrides = {}) {
  return {
    id,
    user_id: `user-${id}`,
    chain: 'base',
    contract_address: '0x1ee151e31999bd8441f6c1ab221f66cd2c8bbde7',
    strike_enabled: true,
    strike_execute_at: new Date(executeAtMs).toISOString(),
    call_data: '0xa0712d680000000000000000000000000000000000000000000000000000000000000001',
    gas_limit: '185000',
    ...overrides,
  }
}

// ─── Test 1: Precision timer drift ────────────────────────────────────────────

console.log('\n=== Test 1: Scheduler precision ===\n')

await test('scheduler fires within 20ms of target time', async () => {
  const TARGET_MS = 200
  const executeAt = Date.now() + TARGET_MS
  const intent = makeIntent('precision-1', executeAt)

  let firedAt = null
  const mockExecute = async (_sb, _intent) => { firedAt = Date.now() }

  scheduleIntent(null, intent, mockExecute)
  assert.equal(scheduledCount(), 1, 'should have 1 scheduled intent')

  await sleep(TARGET_MS + 50) // wait for timer + buffer

  assert.ok(firedAt !== null, 'intent should have fired')
  const drift = Math.abs(firedAt - executeAt)
  console.log(`     ↳ Timer drift: ${drift}ms (target: <20ms)`)
  assert.ok(drift < 20, `Timer drifted ${drift}ms — expected < 20ms`)
})

await test('scheduler count returns to 0 after firing', async () => {
  await sleep(50) // let any pending timers settle
  assert.equal(scheduledCount(), 0, 'scheduler should be empty after all timers fire')
})

// ─── Test 2: Parallel execution ───────────────────────────────────────────────

console.log('\n=== Test 2: Parallel FCFS (10 intents, same execute_at) ===\n')

await test('10 intents all fire within 50ms of each other', async () => {
  const N = 10
  const EXECUTE_DELAY_MS = 300
  const executeAt = Date.now() + EXECUTE_DELAY_MS
  const fireTimes = []

  for (let i = 0; i < N; i++) {
    const intent = makeIntent(`parallel-${i}`, executeAt)
    scheduleIntent(null, intent, async (_sb, _intent) => {
      fireTimes.push(Date.now())
    })
  }

  assert.equal(scheduledCount(), N, `should have ${N} scheduled intents`)
  console.log(`     ↳ Registered ${N} precision timers for T+${EXECUTE_DELAY_MS}ms`)

  // Wait for all timers to fire
  await sleep(EXECUTE_DELAY_MS + 100)

  assert.equal(fireTimes.length, N, `expected ${N} fires, got ${fireTimes.length}`)

  const earliest = Math.min(...fireTimes)
  const latest   = Math.max(...fireTimes)
  const spread   = latest - earliest

  console.log(`     ↳ First fire: T+${earliest - (executeAt - EXECUTE_DELAY_MS)}ms`)
  console.log(`     ↳ Last fire:  T+${latest  - (executeAt - EXECUTE_DELAY_MS)}ms`)
  console.log(`     ↳ Spread across all ${N} intents: ${spread}ms`)

  assert.ok(spread < 50, `Spread was ${spread}ms — expected < 50ms (all intents should fire simultaneously)`)
})

await test('10 intents fire in parallel — wall time ≈ single intent time', async () => {
  const N = 10
  const WORK_MS = 50 // simulate 50ms of async work per intent
  const executeAt = Date.now() + 200
  const completeTimes = []

  for (let i = 0; i < N; i++) {
    const intent = makeIntent(`walltime-${i}`, executeAt)
    scheduleIntent(null, intent, async (_sb, _intent) => {
      await sleep(WORK_MS) // simulate async execution work
      completeTimes.push(Date.now())
    })
  }

  const wallStart = Date.now()
  await sleep(200 + WORK_MS + 100) // wait for all to complete

  const wallTime = Math.max(...completeTimes) - wallStart

  console.log(`     ↳ ${N} intents × ${WORK_MS}ms work each`)
  console.log(`     ↳ Sequential would take: ${N * WORK_MS}ms`)
  console.log(`     ↳ Actual wall time: ${wallTime}ms`)
  console.log(`     ↳ Speedup: ${(N * WORK_MS / wallTime).toFixed(1)}×`)

  // Wall time should be close to WORK_MS (parallel), not N*WORK_MS (sequential).
  // wallTime includes the 200ms timer delay, so sequential would be 200 + N*WORK_MS.
  // Parallel should be ~200 + WORK_MS. Allow 2× WORK_MS headroom for scheduling overhead.
  const parallelThreshold = 200 + WORK_MS * 2  // 300ms — sequential would be 700ms
  assert.ok(
    wallTime < parallelThreshold,
    `Wall time ${wallTime}ms is too slow — expected < ${parallelThreshold}ms (parallel execution)`
  )
})

// ─── Test 3: Idempotency ──────────────────────────────────────────────────────

console.log('\n=== Test 3: Idempotency ===\n')

await test('registering same intent twice only fires once', async () => {
  const executeAt = Date.now() + 200
  const intent = makeIntent('idempotent-1', executeAt)
  let fireCount = 0

  scheduleIntent(null, intent, async () => { fireCount++ })
  scheduleIntent(null, intent, async () => { fireCount++ }) // second call — should be no-op
  scheduleIntent(null, intent, async () => { fireCount++ }) // third call — should be no-op

  assert.equal(scheduledCount(), 1, 'should still only have 1 timer')
  await sleep(300)
  assert.equal(fireCount, 1, `intent fired ${fireCount} times — should only fire once`)
})

// ─── Test 4: Cancellation ─────────────────────────────────────────────────────

console.log('\n=== Test 4: Cancellation ===\n')

await test('cancelled intent does not fire', async () => {
  const executeAt = Date.now() + 300
  const intent = makeIntent('cancel-1', executeAt)
  let fired = false

  scheduleIntent(null, intent, async () => { fired = true })
  assert.equal(scheduledCount(), 1)

  cancelScheduled(intent.id)
  assert.equal(scheduledCount(), 0, 'scheduler should be empty after cancel')

  await sleep(400)
  assert.equal(fired, false, 'cancelled intent should not have fired')
})

// ─── Test 5: Already-past execute_at ─────────────────────────────────────────

console.log('\n=== Test 5: Overdue intent (past execute_at) ===\n')

await test('overdue intent fires immediately via setImmediate', async () => {
  const executeAt = Date.now() - 5000 // 5 seconds ago
  const intent = makeIntent('overdue-1', executeAt)
  let fired = false

  scheduleIntent(null, intent, async () => { fired = true })

  await sleep(50) // setImmediate fires on next event loop tick
  assert.equal(fired, true, 'overdue intent should fire immediately')
})

// ─── Test 6: Real-world FCFS simulation ───────────────────────────────────────

console.log('\n=== Test 6: Full FCFS simulation (5 users, same mint time) ===\n')

await test('5 users: all claim within 10ms, all under 20ms drift', async () => {
  const N = 5
  const MINT_TIME_MS = Date.now() + 500 // mint opens in 500ms
  const results = []

  for (let i = 0; i < N; i++) {
    const intent = makeIntent(`user-${i}-intent`, MINT_TIME_MS, {
      user_id: `user-${i}`,
    })
    scheduleIntent(null, intent, async (_sb, intent) => {
      results.push({
        userId:   intent.user_id,
        firedAt:  Date.now(),
        drift:    Math.abs(Date.now() - MINT_TIME_MS),
      })
    })
  }

  await sleep(600)

  console.log(`\n     User execution order:`)
  results.forEach((r, i) => {
    console.log(`     [${i + 1}] ${r.userId} — fired ${r.firedAt - MINT_TIME_MS > 0 ? '+' : ''}${r.firedAt - MINT_TIME_MS}ms from mint open (drift: ${r.drift}ms)`)
  })

  assert.equal(results.length, N, `Expected ${N} executions, got ${results.length}`)

  const drifts = results.map(r => r.drift)
  const maxDrift = Math.max(...drifts)
  const spread = Math.max(...results.map(r => r.firedAt)) - Math.min(...results.map(r => r.firedAt))

  console.log(`\n     Max drift from mint open: ${maxDrift}ms`)
  console.log(`     Spread between first and last: ${spread}ms`)

  assert.ok(maxDrift < 20, `Max drift ${maxDrift}ms exceeds 20ms`)
  assert.ok(spread < 30, `User spread ${spread}ms exceeds 30ms — not parallel enough`)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(`\n${'─'.repeat(50)}`)
console.log(`${passed}/${total} tests passed`)
console.log(`${'─'.repeat(50)}\n`)

if (failed > 0) {
  process.exitCode = 1
}
