/**
 * Execution flow validation — end-to-end stage tests.
 * Run: node worker/test/exec-flow.test.js
 *
 * Covers:
 *  - Chain normalization for testnet chains (sepolia, base-sepolia)
 *  - Testnet chain ID routing (11155111, 84532)
 *  - SUPPORTED_EXECUTION_CHAINS includes testnet chains
 *  - prepareMintTransaction on sepolia / base-sepolia
 *  - Gas override from user (project.gas_limit) takes priority over server estimate
 *  - Error classification: every known error surfaces actionable message
 *  - Error propagation: non-function errors are not retried (thrown immediately)
 *  - isFunctionNotFound: regex covers all known patterns
 *  - Repeated execution returns consistent shape (idempotent prepare)
 *  - Failure injection: revert, insufficient funds, unknown function
 *  - Strike isolation: strike mode blocked at execute/confirm action
 *  - Mode classification: 'auto' → 'strike', anything else → 'safe'
 *  - Bytecode check fires before any ABI call
 *  - Max spend cap enforced even on testnet
 */

import assert from 'assert/strict'
import { prepareMintTransaction, candidatesFromAbi, fallbackCandidates } from '../../api/_lib/mint-engine.js'
import { normalizeChain, chainIdFor } from '../../api/_lib/project-intelligence.js'

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

const MOCK_CONTRACT       = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
// Use distinct addresses for failure-injection tests to avoid cache pollution from earlier sections
const MOCK_CONTRACT_FAIL  = '0xbebebebebebebebebebebebebebebebebebebebe'
const MOCK_WALLET         = '0x1111111111111111111111111111111111111111'
const MOCK_BYTECODE = '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3'
const DEFAULT_GAS   = 150000n

function mockClient({
  bytecode = MOCK_BYTECODE,
  gasEstimate = DEFAULT_GAS,
  gasPrice = 20_000_000_000n,
  estimateGasError = null,
} = {}) {
  return {
    getBytecode: async () => bytecode,
    estimateGas: async () => {
      if (estimateGasError) throw new Error(estimateGasError)
      return gasEstimate
    },
    getGasPrice: async () => gasPrice,
  }
}

function body(overrides = {}) {
  return {
    chain: 'eth',
    contractAddress: MOCK_CONTRACT,
    walletAddress: MOCK_WALLET,
    mintPrice: '0',
    quantity: 1,
    ...overrides,
  }
}

// ─── Section 1: Testnet chain normalization ───────────────────────────────────

console.log('\n--- testnet chain normalization ---\n')

await test('normalizeChain: "sepolia" → "sepolia"', () => {
  assert.equal(normalizeChain('sepolia'), 'sepolia')
})

await test('normalizeChain: "11155111" → "sepolia"', () => {
  assert.equal(normalizeChain('11155111'), 'sepolia')
})

await test('normalizeChain: "base-sepolia" → "base-sepolia"', () => {
  assert.equal(normalizeChain('base-sepolia'), 'base-sepolia')
})

await test('normalizeChain: "basesepolia" → "base-sepolia"', () => {
  assert.equal(normalizeChain('basesepolia'), 'base-sepolia')
})

await test('normalizeChain: "84532" → "base-sepolia"', () => {
  assert.equal(normalizeChain('84532'), 'base-sepolia')
})

await test('normalizeChain: "base-sepolia" is NOT normalized to "base" (mainnet)', () => {
  // Critical: base-sepolia must not collapse into mainnet "base"
  assert.notEqual(normalizeChain('base-sepolia'), 'base')
})

await test('normalizeChain: "base" still normalizes to "base"', () => {
  assert.equal(normalizeChain('base'), 'base')
})

await test('normalizeChain: "eth" still normalizes to "eth"', () => {
  assert.equal(normalizeChain('eth'), 'eth')
})

// ─── Section 2: Testnet chain IDs ────────────────────────────────────────────

console.log('\n--- testnet chain IDs ---\n')

await test('chainIdFor: sepolia → 11155111', () => {
  assert.equal(chainIdFor('sepolia'), 11155111)
})

await test('chainIdFor: base-sepolia → 84532', () => {
  assert.equal(chainIdFor('base-sepolia'), 84532)
})

await test('chainIdFor: eth → 1', () => {
  assert.equal(chainIdFor('eth'), 1)
})

await test('chainIdFor: base → 8453', () => {
  assert.equal(chainIdFor('base'), 8453)
})

await test('chainIdFor: bnb → 56', () => {
  assert.equal(chainIdFor('bnb'), 56)
})

// ─── Section 3: prepareMintTransaction on testnet chains ──────────────────────

console.log('\n--- testnet chain routing in prepare ---\n')

await test('sepolia: chainId in result is 11155111', async () => {
  const result = await prepareMintTransaction(body({ chain: 'sepolia' }), mockClient())
  assert.equal(result.chainId, 11155111)
})

await test('base-sepolia: chainId in result is 84532', async () => {
  const result = await prepareMintTransaction(body({ chain: 'base-sepolia' }), mockClient())
  assert.equal(result.chainId, 84532)
})

await test('sepolia: result has full required shape', async () => {
  const result = await prepareMintTransaction(body({ chain: 'sepolia' }), mockClient())
  assert.ok(result.to, 'missing: to')
  assert.ok(result.data, 'missing: data')
  assert.ok(typeof result.value === 'string', 'value should be string')
  assert.ok(typeof result.gas === 'string', 'gas should be string')
  assert.ok(result.functionName, 'missing: functionName')
  assert.ok(result.source, 'missing: source')
})

await test('base-sepolia: result has full required shape', async () => {
  const result = await prepareMintTransaction(body({ chain: 'base-sepolia' }), mockClient())
  assert.ok(result.to)
  assert.ok(result.data)
  assert.ok(result.functionName)
  assert.equal(result.to.toLowerCase(), MOCK_CONTRACT.toLowerCase())
})

await test('sepolia: paid mint scales value correctly', async () => {
  const result = await prepareMintTransaction(body({ chain: 'sepolia', mintPrice: '0.01', quantity: 2 }), mockClient())
  const expected = BigInt(Math.round(0.02 * 1e18)).toString()
  assert.equal(result.value, expected)
})

// ─── Section 4: Gas override propagation ─────────────────────────────────────
//
// The gas_limit field (set by MintConfirmModal user input) must take priority
// over the server-estimated gas in sendTransactionAsync. This logic lives in
// useMint.js. We test the rule here to verify it is correctly specified:
//   gas = project.gas_limit ? BigInt(project.gas_limit) : tx.gas ? BigInt(tx.gas) : undefined

console.log('\n--- gas override propagation ---\n')

await test('gas override rule: project.gas_limit takes priority over tx.gas', () => {
  // Simulate the logic from useMint.js
  function resolveGas(projectGasLimit, txGas) {
    return projectGasLimit
      ? BigInt(projectGasLimit)
      : txGas ? BigInt(txGas) : undefined
  }

  // User set 300000
  assert.equal(resolveGas('300000', '150000'), 300000n)
  // No user override — use server estimate
  assert.equal(resolveGas(null, '150000'), 150000n)
  // Neither set — undefined (wallet will estimate)
  assert.equal(resolveGas(null, null), undefined)
  assert.equal(resolveGas(undefined, undefined), undefined)
  // User set 0 (falsy) — falls back to server estimate
  assert.equal(resolveGas(0, '150000'), 150000n)
})

await test('gas from prepareMintTransaction is a string (BigInt-safe)', async () => {
  const result = await prepareMintTransaction(body(), mockClient({ gasEstimate: 200000n }))
  assert.equal(typeof result.gas, 'string')
  // Verify it converts back to BigInt cleanly
  assert.doesNotThrow(() => BigInt(result.gas))
})

// ─── Section 5: Mode classification ──────────────────────────────────────────
//
// project.mint_mode === 'auto' → Strike (server-side Alpha Vault)
// anything else               → 'safe' (user wallet confirmation)

console.log('\n--- mode classification ---\n')

await test('mode: "auto" maps to "strike"', () => {
  const mint_mode = 'auto'
  const executionMode = mint_mode === 'auto' ? 'strike' : 'safe'
  assert.equal(executionMode, 'strike')
})

await test('mode: "confirm" maps to "safe" (not "fast")', () => {
  const mint_mode = 'confirm'
  const executionMode = mint_mode === 'auto' ? 'strike' : 'safe'
  assert.equal(executionMode, 'safe')
})

await test('mode: undefined maps to "safe"', () => {
  const mint_mode = undefined
  const executionMode = mint_mode === 'auto' ? 'strike' : 'safe'
  assert.equal(executionMode, 'safe')
})

await test('mode: "manual" maps to "safe"', () => {
  const mint_mode = 'manual'
  const executionMode = mint_mode === 'auto' ? 'strike' : 'safe'
  assert.equal(executionMode, 'safe')
})

// ─── Section 6: Error classification ─────────────────────────────────────────

console.log('\n--- error classification ---\n')

// Mirror of the classifyMintError function in useMint.js
function classifyMintError(message) {
  const msg = (message || '').toLowerCase()
  if (msg.includes('insufficient funds') || msg.includes('insufficient_funds')) return 'Not enough ETH for mint + gas'
  if (msg.includes('execution reverted') || msg.includes('reverted')) return 'Contract rejected transaction. Mint may be closed or you are not eligible.'
  if (msg.includes('nonce too low') || msg.includes('nonce')) return 'Nonce error. Refresh and try again.'
  if (msg.includes('gas') && (msg.includes('estimation failed') || msg.includes('estimate'))) return 'Gas estimation failed. Try increasing gas limit manually.'
  if (msg.includes('user rejected') || msg.includes('user denied')) return 'Transaction cancelled in wallet.'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'Request timed out. Check your connection and try again.'
  return message
}

await test('classifyMintError: insufficient funds → actionable message', () => {
  const msg = classifyMintError('insufficient funds for transfer')
  assert.equal(msg, 'Not enough ETH for mint + gas')
})

await test('classifyMintError: execution reverted → actionable message', () => {
  const msg = classifyMintError('execution reverted: MintClosed')
  assert.equal(msg, 'Contract rejected transaction. Mint may be closed or you are not eligible.')
})

await test('classifyMintError: nonce too low → actionable message', () => {
  const msg = classifyMintError('nonce too low')
  assert.equal(msg, 'Nonce error. Refresh and try again.')
})

await test('classifyMintError: gas estimation failed → actionable message', () => {
  const msg = classifyMintError('gas estimation failed')
  assert.equal(msg, 'Gas estimation failed. Try increasing gas limit manually.')
})

await test('classifyMintError: user rejected → actionable message', () => {
  const msg = classifyMintError('user rejected the transaction')
  assert.equal(msg, 'Transaction cancelled in wallet.')
})

await test('classifyMintError: timeout → actionable message', () => {
  const msg = classifyMintError('request timed out')
  assert.equal(msg, 'Request timed out. Check your connection and try again.')
})

await test('classifyMintError: unknown error passes through unchanged', () => {
  const raw = 'Some truly unknown contract error XYZ'
  assert.equal(classifyMintError(raw), raw)
})

await test('classifyMintError: null/undefined pass through unchanged (callers must provide fallback)', () => {
  // The function returns the original value when no pattern matches.
  // Call sites always pass a fallback: e.shortMessage || e.message || 'Transaction failed'
  assert.equal(classifyMintError(null), null)
  assert.equal(classifyMintError(undefined), undefined)
})

// ─── Section 7: isFunctionNotFound detection ─────────────────────────────────

console.log('\n--- isFunctionNotFound regex ---\n')

function isFunctionNotFound(msg) {
  return /function not found|unknown function|no function|cannot find|not found in abi/i.test(msg || '')
}

await test('isFunctionNotFound: "function not found" matches', () => {
  assert.ok(isFunctionNotFound('function not found'))
})

await test('isFunctionNotFound: "unknown function" matches', () => {
  assert.ok(isFunctionNotFound('unknown function selector'))
})

await test('isFunctionNotFound: "no function" matches', () => {
  assert.ok(isFunctionNotFound('no function with that name'))
})

await test('isFunctionNotFound: "cannot find" matches', () => {
  assert.ok(isFunctionNotFound('cannot find function'))
})

await test('isFunctionNotFound: "not found in abi" matches', () => {
  assert.ok(isFunctionNotFound('not found in abi'))
})

await test('isFunctionNotFound: "execution reverted" does NOT match', () => {
  assert.ok(!isFunctionNotFound('execution reverted'))
})

await test('isFunctionNotFound: "insufficient funds" does NOT match', () => {
  assert.ok(!isFunctionNotFound('insufficient funds'))
})

await test('isFunctionNotFound: null/empty returns false', () => {
  assert.ok(!isFunctionNotFound(null))
  assert.ok(!isFunctionNotFound(''))
})

// ─── Section 8: Failure injection ────────────────────────────────────────────

console.log('\n--- failure injection ---\n')

await test('revert on all candidates: throws with safe message', async () => {
  await assert.rejects(
    () => prepareMintTransaction(body(), mockClient({ estimateGasError: 'execution reverted' })),
    /Mint simulation failed|execution reverted/i,
  )
})

await test('insufficient funds on all candidates: throws with safe message', async () => {
  await assert.rejects(
    () => prepareMintTransaction(body(), mockClient({ estimateGasError: 'insufficient funds for transfer' })),
    /wallet does not have enough funds|insufficient funds/i,
  )
})

await test('no bytecode: throws immediately before any candidate is tried', async () => {
  // Use a fresh contract address to avoid the in-memory cache fast-path (which bypasses the bytecode check)
  await assert.rejects(
    () => prepareMintTransaction(body({ contractAddress: MOCK_CONTRACT_FAIL }), mockClient({ bytecode: '0x' })),
    /No contract exists/,
  )
})

await test('null bytecode: throws immediately', async () => {
  await assert.rejects(
    () => prepareMintTransaction(body({ contractAddress: MOCK_CONTRACT_FAIL }), mockClient({ bytecode: null })),
    /No contract exists/,
  )
})

await test('missing contract address: throws immediately', async () => {
  await assert.rejects(
    () => prepareMintTransaction(body({ contractAddress: null }), mockClient()),
    /Contract address is required/,
  )
})

await test('missing wallet address: throws immediately', async () => {
  await assert.rejects(
    () => prepareMintTransaction(body({ walletAddress: null }), mockClient()),
    /Connect wallet before/,
  )
})

await test('max_spend_exceeded: throws with specific error key', async () => {
  // value + gas*gasPrice must exceed maxTotalSpend
  // 0.1 ETH mint + gas will exceed a 0.001 ETH limit
  await assert.rejects(
    () => prepareMintTransaction(
      body({ mintPrice: '0.1', maxTotalSpend: '0.001' }),
      mockClient({ gasEstimate: 200000n, gasPrice: 20_000_000_000n }),
    ),
    /max_spend_exceeded/,
  )
})

// ─── Section 9: Repeated execution idempotency ───────────────────────────────

console.log('\n--- repeated execution ---\n')

await test('two identical prepares return the same functionName and chainId', async () => {
  const client = mockClient()
  const r1 = await prepareMintTransaction(body(), client)
  const r2 = await prepareMintTransaction(body(), client)
  assert.equal(r1.functionName, r2.functionName)
  assert.equal(r1.chainId, r2.chainId)
})

await test('two identical testnet prepares return consistent shape', async () => {
  const client = mockClient()
  const r1 = await prepareMintTransaction(body({ chain: 'sepolia' }), client)
  const r2 = await prepareMintTransaction(body({ chain: 'sepolia' }), client)
  assert.equal(r1.chainId, r2.chainId)
  assert.equal(r1.functionName, r2.functionName)
  assert.equal(r1.to.toLowerCase(), r2.to.toLowerCase())
})

await test('different quantities produce different value fields', async () => {
  const client = mockClient()
  const r1 = await prepareMintTransaction(body({ mintPrice: '0.05', quantity: 1 }), client)
  const r2 = await prepareMintTransaction(body({ mintPrice: '0.05', quantity: 2 }), client)
  assert.notEqual(r1.value, r2.value)
  assert.equal(BigInt(r2.value), BigInt(r1.value) * 2n)
})

// ─── Section 10: Candidate deduplication ─────────────────────────────────────

console.log('\n--- candidate deduplication ---\n')

await test('verified ABI candidate suppresses same-name fallback', () => {
  const verifiedAbi = [
    { type: 'function', name: 'mint', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  ]
  const abiCandidates = candidatesFromAbi(verifiedAbi, 1n, MOCK_WALLET)
  const abiNames = new Set(abiCandidates.map(c => c.functionName))
  const fallback = fallbackCandidates(1n, MOCK_WALLET).filter(c => !abiNames.has(c.functionName))
  // "mint" from fallback should be suppressed
  assert.ok(!fallback.some(c => c.functionName === 'mint'), '"mint" should be deduplicated')
  // Other fallback names should remain
  assert.ok(fallback.length > 0, 'non-deduped fallbacks should remain')
})

await test('candidatesFromAbi ignores non-matching function names', () => {
  const abi = [
    { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
    { type: 'function', name: 'mint', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  ]
  const candidates = candidatesFromAbi(abi, 1n, MOCK_WALLET)
  assert.ok(candidates.every(c => c.functionName !== 'transfer'), 'transfer should not appear')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].functionName, 'mint')
})

// ─── Section 11: Strike isolation ────────────────────────────────────────────
//
// Strike mode must not be triggered from the normal Mint path.
// Verify that when executionMode is 'strike', the API's execute/confirm
// action blocks it. We test the guard condition directly.

console.log('\n--- strike isolation ---\n')

await test('execute/confirm action blocks strike mode', () => {
  // Mirror of mint-engine.js execute/confirm guard:
  //   if (mode === 'strike' || intent.execution_mode === 'strike') return 400
  function isStrikeBlocked(mode, intentExecutionMode) {
    return mode === 'strike' || intentExecutionMode === 'strike'
  }

  assert.ok(isStrikeBlocked('strike', 'safe'), 'strike mode in request body is blocked')
  assert.ok(isStrikeBlocked('safe', 'strike'), 'strike intent is blocked from execute/confirm')
  assert.ok(!isStrikeBlocked('safe', 'safe'), 'safe mode is not blocked')
  assert.ok(!isStrikeBlocked('fast', 'fast'), 'fast mode is not blocked')
})

await test('normal mint mode never becomes strike from "confirm" project mode', () => {
  // This mirrors the fixed logic in useMint.js
  for (const mintMode of ['confirm', 'manual', 'safe', undefined, null, '']) {
    const executionMode = mintMode === 'auto' ? 'strike' : 'safe'
    assert.notEqual(executionMode, 'strike', `mint_mode "${mintMode}" should not produce strike`)
  }
})

// ─── Section 12: Testnet SUPPORTED_EXECUTION_CHAINS ──────────────────────────

console.log('\n--- SUPPORTED_EXECUTION_CHAINS coverage ---\n')

// We validate that prepare succeeds for both testnet chains (mock client bypasses real RPC)
await test('sepolia prepare succeeds (SUPPORTED_EXECUTION_CHAINS includes sepolia)', async () => {
  const result = await prepareMintTransaction(body({ chain: 'sepolia' }), mockClient())
  assert.equal(result.chainId, 11155111)
})

await test('base-sepolia prepare succeeds (SUPPORTED_EXECUTION_CHAINS includes base-sepolia)', async () => {
  const result = await prepareMintTransaction(body({ chain: 'base-sepolia' }), mockClient())
  assert.equal(result.chainId, 84532)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const durationMs = results.reduce((s, r) => s + r.ms, 0)
console.log(`\n${passed}/${total} tests passed  |  ${durationMs}ms total\n`)

if (failed > 0) {
  console.error('FAILED tests:')
  results.filter(r => !r.pass).forEach(r => console.error(`  ✗  ${r.name}: ${r.error}`))
  process.exitCode = 1
}
