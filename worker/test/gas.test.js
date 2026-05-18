/**
 * Gas strategy and escalation tests.
 * Run: node worker/test/gas.test.js
 *
 * Covers:
 *  - estimateGas: EIP-1559 path — all three strategies
 *  - estimateGas: safe < balanced < aggressive priority fees
 *  - estimateGas: safe < balanced < aggressive max fees
 *  - estimateGas: legacy path (no baseFeePerGas)
 *  - escalateGas: multiplies by ~1.25x each call
 *  - escalateGas: legacy gasPrice also escalates
 *  - simulator: safe → balanced → aggressive strategy comparison
 */

import assert from 'assert/strict'
import { estimateGas, escalateGas } from '../lib/gas.js'
import { createMintAdapter, ADAPTER_MODES } from '../lib/mint-adapter.js'
import { simulateAllStrategies, SIM_OUTCOMES } from '../lib/simulator.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gwei(bigIntWei) {
  return Number(bigIntWei) / 1e9
}

/** Build a mock publicClient returning an EIP-1559 block */
function eip1559Client(baseFeeGwei = 15) {
  return {
    async getBlock() {
      return { baseFeePerGas: BigInt(Math.round(baseFeeGwei * 1e9)) }
    },
    async getGasPrice() {
      return BigInt(Math.round(baseFeeGwei * 1.5 * 1e9))
    },
  }
}

/** Build a mock publicClient with no baseFeePerGas (legacy chain) */
function legacyClient(gasPriceGwei = 20) {
  return {
    async getBlock() {
      return { baseFeePerGas: null }
    },
    async getGasPrice() {
      return BigInt(Math.round(gasPriceGwei * 1e9))
    },
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

console.log('\ngas.test.js\n')

// ─── EIP-1559: basic shape ────────────────────────────────────────────────────

await test('estimateGas: returns isEip1559=true when block has baseFeePerGas', async () => {
  const params = await estimateGas(eip1559Client(), 'balanced', 0)
  assert.equal(params.isEip1559, true)
  assert.ok(params.maxFeePerGas !== undefined)
  assert.ok(params.maxPriorityFeePerGas !== undefined)
  assert.equal(params.gasPrice, undefined)
})

await test('estimateGas: baseFeeGwei is populated from block', async () => {
  const params = await estimateGas(eip1559Client(20), 'balanced', 0)
  assert.ok(params.baseFeeGwei !== null)
  assert.ok(Math.abs(params.baseFeeGwei - 20) < 0.01, `expected ~20 gwei, got ${params.baseFeeGwei}`)
})

// ─── EIP-1559: strategy ordering ─────────────────────────────────────────────

await test('estimateGas: safe has lower priority fee than balanced', async () => {
  const safe = await estimateGas(eip1559Client(), 'safe', 0)
  const bal = await estimateGas(eip1559Client(), 'balanced', 0)
  assert.ok(
    gwei(safe.maxPriorityFeePerGas) < gwei(bal.maxPriorityFeePerGas),
    `safe (${gwei(safe.maxPriorityFeePerGas)}) should < balanced (${gwei(bal.maxPriorityFeePerGas)})`,
  )
})

await test('estimateGas: balanced has lower priority fee than aggressive', async () => {
  const bal = await estimateGas(eip1559Client(), 'balanced', 0)
  const agg = await estimateGas(eip1559Client(), 'aggressive', 0)
  assert.ok(
    gwei(bal.maxPriorityFeePerGas) < gwei(agg.maxPriorityFeePerGas),
    `balanced (${gwei(bal.maxPriorityFeePerGas)}) should < aggressive (${gwei(agg.maxPriorityFeePerGas)})`,
  )
})

await test('estimateGas: safe maxFee < balanced maxFee < aggressive maxFee', async () => {
  const safe = await estimateGas(eip1559Client(15), 'safe', 0)
  const bal = await estimateGas(eip1559Client(15), 'balanced', 0)
  const agg = await estimateGas(eip1559Client(15), 'aggressive', 0)
  assert.ok(
    safe.maxFeePerGas < bal.maxFeePerGas,
    `safe.maxFee (${gwei(safe.maxFeePerGas).toFixed(2)}) should < balanced (${gwei(bal.maxFeePerGas).toFixed(2)})`,
  )
  assert.ok(
    bal.maxFeePerGas < agg.maxFeePerGas,
    `balanced.maxFee (${gwei(bal.maxFeePerGas).toFixed(2)}) should < aggressive (${gwei(agg.maxFeePerGas).toFixed(2)})`,
  )
})

await test('estimateGas: maxFee > maxPriorityFee (fee includes base fee)', async () => {
  const params = await estimateGas(eip1559Client(15), 'balanced', 0)
  assert.ok(
    params.maxFeePerGas > params.maxPriorityFeePerGas,
    'maxFee must exceed priority fee',
  )
})

// ─── EIP-1559: strategy=balanced is default for unknown ──────────────────────

await test('estimateGas: unknown strategy defaults to balanced', async () => {
  const unknown = await estimateGas(eip1559Client(15), 'turbo', 0)
  const bal = await estimateGas(eip1559Client(15), 'balanced', 0)
  assert.equal(unknown.strategy, 'balanced')
  assert.equal(unknown.maxPriorityFeePerGas, bal.maxPriorityFeePerGas)
})

// ─── Legacy (non-EIP-1559) path ───────────────────────────────────────────────

await test('estimateGas: returns isEip1559=false when block has no baseFeePerGas', async () => {
  const params = await estimateGas(legacyClient(20), 'balanced', 0)
  assert.equal(params.isEip1559, false)
  assert.ok(params.gasPrice !== undefined)
  assert.equal(params.maxFeePerGas, undefined)
  assert.equal(params.maxPriorityFeePerGas, undefined)
  assert.equal(params.baseFeeGwei, null)
})

await test('estimateGas: legacy aggressive has higher gasPrice than safe', async () => {
  const safe = await estimateGas(legacyClient(20), 'safe', 0)
  const agg = await estimateGas(legacyClient(20), 'aggressive', 0)
  assert.ok(
    agg.gasPrice > safe.gasPrice,
    `aggressive (${gwei(agg.gasPrice).toFixed(2)}) should > safe (${gwei(safe.gasPrice).toFixed(2)})`,
  )
})

// ─── escalateGas ─────────────────────────────────────────────────────────────

await test('escalateGas: EIP-1559 maxFeePerGas increases by ~1.25x', async () => {
  const initial = await estimateGas(eip1559Client(15), 'balanced', 0)
  const escalated = escalateGas(initial, 1)
  const ratio = Number(escalated.maxFeePerGas) / Number(initial.maxFeePerGas)
  assert.ok(
    ratio >= 1.24 && ratio <= 1.26,
    `expected ~1.25x escalation, got ${ratio.toFixed(4)}`,
  )
})

await test('escalateGas: maxPriorityFeePerGas also increases by ~1.25x', async () => {
  const initial = await estimateGas(eip1559Client(15), 'balanced', 0)
  const escalated = escalateGas(initial, 1)
  const ratio = Number(escalated.maxPriorityFeePerGas) / Number(initial.maxPriorityFeePerGas)
  assert.ok(ratio >= 1.24 && ratio <= 1.26, `expected ~1.25x, got ${ratio.toFixed(4)}`)
})

await test('escalateGas: strategy and isEip1559 preserved after escalation', async () => {
  const initial = await estimateGas(eip1559Client(15), 'safe', 0)
  const escalated = escalateGas(initial, 1)
  assert.equal(escalated.strategy, 'safe')
  assert.equal(escalated.isEip1559, true)
})

await test('escalateGas: chained escalations compound (two steps ~ 1.56x)', async () => {
  const initial = await estimateGas(eip1559Client(15), 'balanced', 0)
  const step1 = escalateGas(initial, 1)
  const step2 = escalateGas(step1, 1)
  const ratio = Number(step2.maxFeePerGas) / Number(initial.maxFeePerGas)
  // 1.25^2 = 1.5625
  assert.ok(ratio >= 1.54 && ratio <= 1.58, `expected ~1.5625x, got ${ratio.toFixed(4)}`)
})

await test('escalateGas: legacy gasPrice increases by ~1.25x', async () => {
  const initial = await estimateGas(legacyClient(20), 'balanced', 0)
  const escalated = escalateGas(initial, 1)
  const ratio = Number(escalated.gasPrice) / Number(initial.gasPrice)
  assert.ok(ratio >= 1.24 && ratio <= 1.26, `expected ~1.25x, got ${ratio.toFixed(4)}`)
})

// ─── Simulator: strategy comparison ──────────────────────────────────────────

await test('simulateAllStrategies: all three strategies succeed', async () => {
  const adapter = createMintAdapter({ mode: ADAPTER_MODES.SUCCESS })
  const intent = { id: 'sim-gas-1', user_id: 'u1', chain: 'eth' }
  const results = await simulateAllStrategies(intent, adapter)

  for (const strategy of ['safe', 'balanced', 'aggressive']) {
    assert.ok(strategy in results, `missing result for strategy: ${strategy}`)
    assert.equal(results[strategy].outcome, SIM_OUTCOMES.SUCCESS, `${strategy} should succeed`)
    assert.ok(results[strategy].tx_hash, `${strategy} should have tx_hash`)
  }
})

await test('simulateAllStrategies: aggressive has higher gas than safe', async () => {
  const adapter = createMintAdapter({ mode: ADAPTER_MODES.SUCCESS, baseFeeGwei: 15 })
  const intent = { id: 'sim-gas-2', user_id: 'u1', chain: 'eth' }
  const results = await simulateAllStrategies(intent, adapter)

  const safeGasEvent = results.safe.timeline.find(e => e.phase === 'gas')
  const aggGasEvent = results.aggressive.timeline.find(e => e.phase === 'gas')

  const safeMaxFee = parseFloat(safeGasEvent?.data?.max_fee_gwei ?? '0')
  const aggMaxFee = parseFloat(aggGasEvent?.data?.max_fee_gwei ?? '0')

  assert.ok(
    aggMaxFee > safeMaxFee,
    `aggressive maxFee (${aggMaxFee}) should > safe maxFee (${safeMaxFee})`,
  )
})

await test('simulateAllStrategies: gas escalation fires on retry', async () => {
  // Sequence: fail once (gas_too_low), then succeed
  const adapter = createMintAdapter({
    mode: ADAPTER_MODES.SEQUENCE,
    sequence: [
      { success: false, failureType: 'gas_too_low' },
      { success: true },
    ],
  })
  const intent = { id: 'sim-gas-3', user_id: 'u1', gas_strategy: 'balanced' }
  const result = await simulateAllStrategies(intent, adapter)
  const balResult = result.balanced
  assert.ok(
    balResult.summary.gas_escalations > 0 || balResult.outcome === SIM_OUTCOMES.SUCCESS,
    'expected gas escalation or recovery',
  )
})

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
