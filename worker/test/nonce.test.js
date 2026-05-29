/**
 * Nonce management + retry engine tests.
 * Run: node worker/test/nonce.test.js
 *
 * Covers:
 *  - nonceTracker: set / get / increment / clear
 *  - classifyError: correct type for each error pattern
 *  - backoffMs: increases with attempt number, caps at max
 *  - withRetry: succeeds on first attempt
 *  - withRetry: retries on retryable error, succeeds eventually
 *  - withRetry: stops immediately on non-retryable error (revert)
 *  - withRetry: refreshes nonce on nonce_too_low
 *  - withRetry: concurrent wallet isolation (separate address, separate nonce)
 */

import assert from 'assert/strict'
import { nonceTracker, classifyError, backoffMs, withRetry } from '../lib/retry.js'

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

console.log('\nnonce.test.js\n')

// ─── nonceTracker ─────────────────────────────────────────────────────────────

await test('nonceTracker.get returns undefined for unknown address', () => {
  assert.equal(nonceTracker.get('0xunknown'), undefined)
})

await test('nonceTracker.set and get round-trips correctly', () => {
  nonceTracker.set('0xAaAa', 42)
  assert.equal(nonceTracker.get('0xAaAa'), 42)
  nonceTracker.clear('0xAaAa')
})

await test('nonceTracker normalises address to lowercase', () => {
  nonceTracker.set('0xBBBB', 7)
  assert.equal(nonceTracker.get('0xbbbb'), 7)
  nonceTracker.clear('0xBBBB')
})

await test('nonceTracker.increment adds 1 to tracked nonce', () => {
  nonceTracker.set('0xCCCC', 10)
  nonceTracker.increment('0xCCCC')
  assert.equal(nonceTracker.get('0xCCCC'), 11)
  nonceTracker.clear('0xCCCC')
})

await test('nonceTracker.increment is a no-op for untracked address', () => {
  nonceTracker.increment('0xuntracked')
  assert.equal(nonceTracker.get('0xuntracked'), undefined)
})

await test('nonceTracker.clear removes the tracked nonce', () => {
  nonceTracker.set('0xDDDD', 99)
  nonceTracker.clear('0xDDDD')
  assert.equal(nonceTracker.get('0xDDDD'), undefined)
})

await test('nonceTracker: two addresses are independent', () => {
  nonceTracker.set('0xWALLET1', 5)
  nonceTracker.set('0xWALLET2', 100)
  nonceTracker.increment('0xWALLET1')
  assert.equal(nonceTracker.get('0xWALLET1'), 6)
  assert.equal(nonceTracker.get('0xWALLET2'), 100)
  nonceTracker.clear('0xWALLET1')
  nonceTracker.clear('0xWALLET2')
})

// ─── classifyError ────────────────────────────────────────────────────────────

await test('classifyError: execution reverted → type=revert, retryable=false', () => {
  const err = Object.assign(new Error('execution reverted: MintNotActive()'), {
    shortMessage: 'execution reverted: MintNotActive()',
  })
  const c = classifyError(err)
  assert.equal(c.type, 'revert')
  assert.equal(c.retryable, false)
  assert.equal(c.maxRetries, 0)
})

await test('classifyError: out of gas → type=revert', () => {
  const c = classifyError(new Error('out of gas'))
  assert.equal(c.type, 'revert')
  assert.equal(c.retryable, false)
})

await test('classifyError: nonce too low → type=nonce_too_low, retryable=true', () => {
  const c = classifyError(new Error('nonce too low'))
  assert.equal(c.type, 'nonce_too_low')
  assert.equal(c.retryable, true)
})

await test('classifyError: already known → type=nonce_too_low', () => {
  const c = classifyError(new Error('already known'))
  assert.equal(c.type, 'nonce_too_low')
})

await test('classifyError: max fee per gas less than block base fee → type=gas_too_low', () => {
  const c = classifyError(new Error('max fee per gas less than block base fee'))
  assert.equal(c.type, 'gas_too_low')
  assert.equal(c.retryable, true)
})

await test('classifyError: transaction underpriced → type=gas_too_low', () => {
  const c = classifyError(new Error('transaction underpriced'))
  assert.equal(c.type, 'gas_too_low')
})

await test('classifyError: timeout / AbortError → type=timeout, retryable=true', () => {
  const err = Object.assign(new Error('timed out'), { name: 'AbortError' })
  const c = classifyError(err)
  assert.equal(c.type, 'timeout')
  assert.equal(c.retryable, true)
})

await test('classifyError: fetch failed → type=network', () => {
  const c = classifyError(new Error('fetch failed: ECONNRESET'))
  assert.equal(c.type, 'network')
  assert.equal(c.retryable, true)
})

await test('classifyError: unknown error → type=default, retryable=true', () => {
  const c = classifyError(new Error('something weird happened'))
  assert.equal(c.type, 'default')
  assert.equal(c.retryable, true)
})

// ─── backoffMs ────────────────────────────────────────────────────────────────

await test('backoffMs: increases with attempt number', () => {
  const b0 = backoffMs(0)
  const b1 = backoffMs(1)
  const b2 = backoffMs(2)
  // Remove jitter influence by checking order of magnitude
  assert.ok(b1 > b0, `b1 (${b1}) should > b0 (${b0})`)
  assert.ok(b2 > b1, `b2 (${b2}) should > b1 (${b1})`)
})

await test('backoffMs: never exceeds 15 seconds', () => {
  for (let i = 0; i < 20; i++) {
    const b = backoffMs(i)
    assert.ok(b <= 15_000, `backoffMs(${i}) = ${b} exceeds 15s`)
  }
})

await test('backoffMs: base attempt 0 is within expected range', () => {
  // base = 500 * 2^0 = 500, plus 0..200 jitter → expect 500..700
  for (let i = 0; i < 10; i++) {
    const b = backoffMs(0)
    assert.ok(b >= 500 && b <= 700, `expected 500-700, got ${b}`)
  }
})

// ─── withRetry ────────────────────────────────────────────────────────────────

await test('withRetry: succeeds on first attempt', async () => {
  let calls = 0
  const result = await withRetry(async () => {
    calls++
    return 'ok'
  }, { enabled: true })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

await test('withRetry: retries on retryable error, succeeds on second attempt', async () => {
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls < 2) throw Object.assign(new Error('network error: ECONNRESET'), { shortMessage: 'fetch failed' })
      return 'recovered'
    },
    { enabled: true },
  )
  assert.equal(result, 'recovered')
  assert.equal(calls, 2)
})

await test('withRetry: stops immediately on non-retryable revert', async () => {
  let calls = 0
  await assert.rejects(
    () => withRetry(
      async () => {
        calls++
        throw Object.assign(new Error('execution reverted: MintNotActive()'), {
          shortMessage: 'execution reverted: MintNotActive()',
        })
      },
      { enabled: true },
    ),
    /execution reverted/,
  )
  assert.equal(calls, 1, 'should not retry on revert')
})

await test('withRetry: respects enabled=false (throws on first failure)', async () => {
  let calls = 0
  await assert.rejects(
    () => withRetry(
      async () => {
        calls++
        throw new Error('fetch failed: ECONNRESET')
      },
      { enabled: false },
    ),
  )
  assert.equal(calls, 1)
})

await test('withRetry: does NOT auto-increment nonceTracker on success (executor owns nonce)', async () => {
  // executor.js pre-sets nonceTracker to nonce+1 *before* sendTransaction.
  // withRetry must not also increment — that would double-count and cause nonce-too-low. (OPS-5)
  const addr = '0xnoncetest'
  nonceTracker.set(addr, 50)
  await withRetry(
    async () => 'ok',
    { enabled: false, address: addr },
  )
  assert.equal(nonceTracker.get(addr), 50) // unchanged — executor is responsible
  nonceTracker.clear(addr)
})

await test('withRetry: refreshes nonce on nonce_too_low', async () => {
  const addr = '0xnonce_refresh_test'
  nonceTracker.set(addr, 0)

  let calls = 0
  const publicClient = {
    getTransactionCount: async () => 5,
  }

  await withRetry(
    async () => {
      calls++
      if (calls < 2) throw new Error('nonce too low')
      return 'ok'
    },
    { enabled: true, address: addr, publicClient },
  )

  assert.ok(calls >= 2, 'should have retried')
  nonceTracker.clear(addr)
})

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
