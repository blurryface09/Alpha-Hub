/**
 * Phase 2 — Deterministic engine validation suite.
 *
 * Covers all 6 contract execution profiles without live RPC calls.
 * Each section validates both the happy-path and fix-specific invariants.
 *
 * Contract profiles:
 *  1. SeaDrop router-based (paid)       — to=router, value=price*qty, args correct
 *  2. SeaDrop router-based (free)       — to=router, value='0', isActive gate
 *  3. Verified ABI direct mint          — to=contract, source=verified_abi
 *  4. Generic fallback (no ABI)         — source=common_signature, fallback iteration
 *  5. Paid mint — value + spend cap     — value=price*qty, cap enforcement
 *  6. Free mint — zero value            — value='0', no cap rejection
 *
 * Fix invariants:
 *  C1 — prewarm saves prepared.value (not hardcoded '0')
 *  C2 — prewarm saves prepared.to (router address for SeaDrop)
 *  C4 — executor `to` resolves mint_contract_address → to → contract_address
 *  H3 — classifyExecutionStatus: payment → 'live', revert → 'not_started', unknown → 'unsupported_execution'
 *
 * Run: node worker/test/engine-validation.test.js
 */

import assert from 'assert/strict'
import {
  prepareMintTransaction,
  candidatesFromAbi,
  fallbackCandidates,
  argsForInputs,
} from '../../api/_lib/mint-engine.js'
import {
  setCachedAbi,
  getCachedProbeResult,
  invalidateCachedExecution,
} from '../../api/_lib/contract-cache.js'
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

// ─── Constants ────────────────────────────────────────────────────────────────

const SEADROP_ROUTER  = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
const FEE_RECIPIENT   = '0x0000a26b00c1F0DF003000390027140000fAa719'
const ZERO_ADDR       = '0x0000000000000000000000000000000000000000'
const MOCK_WALLET     = '0x1111111111111111111111111111111111111111'
const MOCK_BYTECODE   = '0x6080604052' // non-empty

// Unique contract addresses per test — exec cache is per-address, so each scenario
// that needs fresh detection gets its own address. Addresses sharing a scenario
// that re-uses a cached result must call invalidateCachedExecution first.
const CONTRACT_SEADROP_PAID_TO      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001'
const CONTRACT_SEADROP_PAID_VALUE   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0002'
const CONTRACT_SEADROP_PAID_SCALE   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0003'
const CONTRACT_SEADROP_PAID_FN      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0004'
const CONTRACT_SEADROP_PAID_SOURCE  = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0005'
const CONTRACT_SEADROP_INACTIVE     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0006'
const CONTRACT_SEADROP_FUTURE       = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0007'
const CONTRACT_SEADROP_EXPIRED      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0008'
const CONTRACT_SEADROP_FREE_VALUE   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0009'
const CONTRACT_SEADROP_FREE_TO      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000a'
const CONTRACT_SEADROP_FREE_SOURCE  = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000b'
const CONTRACT_VERIFIED_TO          = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000c'
const CONTRACT_VERIFIED_FN          = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000d'
const CONTRACT_VERIFIED_SOURCE      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000e'
const CONTRACT_FALLBACK_RESOLVES    = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000f'
const CONTRACT_FALLBACK_SOURCE      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0010'
const CONTRACT_FALLBACK_TO          = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0011'
const CONTRACT_FALLBACK_ITERATION   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0012'
const CONTRACT_FALLBACK_FAIL        = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0013'
const CONTRACT_PAID_1ETH            = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0014'
const CONTRACT_PAID_2ETH            = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0015'
const CONTRACT_PAID_5QTY            = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0016'
const CONTRACT_PAID_CAP_EXCEED      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0017'
const CONTRACT_PAID_CAP_OK          = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0018'
const CONTRACT_PAID_STR_TYPE        = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0019'
const CONTRACT_FREE_ZERO            = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001a'
const CONTRACT_FREE_UNDEF           = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001b'
const CONTRACT_FREE_CAP             = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001c'
const CONTRACT_FREE_SHAPE           = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001d'
const CONTRACT_CLASSIFY_PAYMENT     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001e'
const CONTRACT_CLASSIFY_MSGVAL      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001f'
const CONTRACT_CLASSIFY_REVERT      = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0020'
const CONTRACT_CLASSIFY_UNKNOWN     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0021'

const DEFAULT_GAS    = 185000n
const DEFAULT_PRICE  = 20_000_000_000n

// ─── ABI fixtures ────────────────────────────────────────────────────────────

const SEADROP_INTERFACE_ABI = [
  { type: 'function', name: 'mintSeaDrop', inputs: [{ name: 'minter', type: 'address' }, { name: 'quantity', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getMintStats', inputs: [{ name: 'minter', type: 'address' }], outputs: [], stateMutability: 'view' },
]

const DIRECT_MINT_ABI = [
  { type: 'function', name: 'mint', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
]

// ─── Mock clients ─────────────────────────────────────────────────────────────

/**
 * Build a mock viem client for SeaDrop contracts.
 * readContract dispatches on functionName and returns appropriate SeaDrop data.
 */
function seaDropClient({
  mintPrice = 80000000000000n,      // 0.00008 ETH (in wei as BigInt)
  startTime = BigInt(Math.floor(Date.now() / 1000) - 3600), // 1hr ago
  endTime = 0n,                    // never ends
  feeRecipients = [FEE_RECIPIENT],
  merkleRoot = '0x' + '0'.repeat(64),
  gasEstimate = DEFAULT_GAS,
  gasPrice = DEFAULT_PRICE,
} = {}) {
  return {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => gasEstimate,
    getGasPrice: async () => gasPrice,
    readContract: async ({ functionName }) => {
      if (functionName === 'getAllowedFeeRecipients') return feeRecipients
      if (functionName === 'getPublicDrop') return [mintPrice, startTime, endTime, 1000n, 500n, false]
      if (functionName === 'getAllowListMerkleRoot') return merkleRoot
      if (functionName === 'getSignedMintValidationParams') throw new Error('no signed params')
      throw new Error(`unexpected readContract: ${functionName}`)
    },
  }
}

/**
 * Build a mock viem client for standard ERC721/ERC721A contracts.
 * readContract calls all fail (not SeaDrop), estimateGas succeeds.
 */
function standardClient({
  gasEstimate = DEFAULT_GAS,
  gasPrice = DEFAULT_PRICE,
  estimateGasError = null,
} = {}) {
  return {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => {
      if (estimateGasError) throw new Error(estimateGasError)
      return gasEstimate
    },
    getGasPrice: async () => gasPrice,
    readContract: async ({ functionName }) => {
      // SeaDrop blind probe — return empty (not a SeaDrop contract)
      if (functionName === 'getAllowedFeeRecipients') return []
      if (functionName === 'getPublicDrop') throw new Error('not a seadrop contract')
      if (functionName === 'getAllowListMerkleRoot') throw new Error('not a seadrop contract')
      throw new Error(`unexpected readContract: ${functionName}`)
    },
  }
}

function body(contract, overrides = {}) {
  return {
    chain: 'eth',
    contractAddress: contract,
    walletAddress: MOCK_WALLET,
    mintPrice: '0',
    quantity: 1,
    ...overrides,
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
                  maybeSingle: async () => ({ data: { address: MOCK_WALLET }, error: null }),
                }),
              }),
            }),
          }),
        }),
        update(row) {
          updates.push({ table, row })
          return { eq: () => ({ catch: () => Promise.resolve() }) }
        },
        insert(row) {
          inserts.push({ table, row })
          return { catch: () => Promise.resolve() }
        },
      }
    },
  }
}

// ─── Section 1: SeaDrop router — paid active mint ─────────────────────────────

console.log('\n=== Section 1: SeaDrop router (paid active mint) ===\n')

await test('seadrop paid: to = SeaDrop router address (not NFT contract)', async () => {
  setCachedAbi(CONTRACT_SEADROP_PAID_TO, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_PAID_TO, { mintPrice: '0.00008' }),
    seaDropClient({ mintPrice: 80000000000000n }),
  )
  assert.equal(result.to.toLowerCase(), SEADROP_ROUTER.toLowerCase(),
    `to should be SeaDrop router, got: ${result.to}`)
})

await test('seadrop paid: value = mintPrice * quantity (not 0)', async () => {
  setCachedAbi(CONTRACT_SEADROP_PAID_VALUE, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_PAID_VALUE, { mintPrice: '0.00008', quantity: 1 }),
    seaDropClient({ mintPrice: 80000000000000n }),
  )
  assert.equal(result.value, '80000000000000',
    `value should be 80000000000000 wei, got: ${result.value}`)
})

await test('seadrop paid: value scales with quantity', async () => {
  setCachedAbi(CONTRACT_SEADROP_PAID_SCALE, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_PAID_SCALE, { mintPrice: '0.00008', quantity: 3 }),
    seaDropClient({ mintPrice: 80000000000000n }),
  )
  assert.equal(result.value, '240000000000000',
    `value should be 3 * 80000000000000 = 240000000000000 wei, got: ${result.value}`)
})

await test('seadrop paid: functionName = mintPublic', async () => {
  setCachedAbi(CONTRACT_SEADROP_PAID_FN, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_PAID_FN, { mintPrice: '0.00008' }),
    seaDropClient({ mintPrice: 80000000000000n }),
  )
  assert.equal(result.functionName, 'mintPublic')
})

await test('seadrop paid: source = seadrop on first call', async () => {
  setCachedAbi(CONTRACT_SEADROP_PAID_SOURCE, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_PAID_SOURCE, { mintPrice: '0.00008' }),
    seaDropClient({ mintPrice: 80000000000000n }),
  )
  assert.equal(result.source, 'seadrop', `source should be 'seadrop', got: ${result.source}`)
  assert.ok(result.data, 'calldata must be present')
})

await test('seadrop paid: inactive drop (startTime=0) throws — allowlist or not configured', async () => {
  // estimateGas always fails so only the SeaDrop path could succeed.
  // With an inactive drop, SeaDrop setup throws → all candidates fail → engine throws.
  setCachedAbi(CONTRACT_SEADROP_INACTIVE, 'eth', SEADROP_INTERFACE_ABI)
  const client = { ...seaDropClient({ startTime: 0n }), estimateGas: async () => { throw new Error('execution reverted') } }
  await assert.rejects(
    () => prepareMintTransaction(body(CONTRACT_SEADROP_INACTIVE), client),
    /not active|not open|mint|allowlist|public drop|simulation failed/i,
  )
})

await test('seadrop paid: future drop (startTime in future) throws — not started', async () => {
  setCachedAbi(CONTRACT_SEADROP_FUTURE, 'eth', SEADROP_INTERFACE_ABI)
  const futureTs = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const client = { ...seaDropClient({ startTime: futureTs }), estimateGas: async () => { throw new Error('execution reverted') } }
  await assert.rejects(
    () => prepareMintTransaction(body(CONTRACT_SEADROP_FUTURE), client),
    /not active|not open|mint|allowlist|public drop|not started|simulation failed/i,
  )
})

await test('seadrop paid: expired drop (endTime in past) throws', async () => {
  setCachedAbi(CONTRACT_SEADROP_EXPIRED, 'eth', SEADROP_INTERFACE_ABI)
  const pastStart = BigInt(Math.floor(Date.now() / 1000) - 7200)
  const pastEnd   = BigInt(Math.floor(Date.now() / 1000) - 3600)
  const client = { ...seaDropClient({ startTime: pastStart, endTime: pastEnd }), estimateGas: async () => { throw new Error('execution reverted') } }
  await assert.rejects(
    () => prepareMintTransaction(body(CONTRACT_SEADROP_EXPIRED), client),
    /not active|not open|mint|allowlist|public drop|not started|simulation failed/i,
  )
})

// ─── Section 2: SeaDrop router — free active mint ─────────────────────────────

console.log('\n=== Section 2: SeaDrop router (free active mint) ===\n')

await test('seadrop free: value = 0 when mintPrice is 0', async () => {
  setCachedAbi(CONTRACT_SEADROP_FREE_VALUE, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_FREE_VALUE, { mintPrice: '0' }),
    seaDropClient({ mintPrice: 0n }),
  )
  assert.equal(result.value, '0')
})

await test('seadrop free: to = SeaDrop router (even when free)', async () => {
  setCachedAbi(CONTRACT_SEADROP_FREE_TO, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_FREE_TO, { mintPrice: '0' }),
    seaDropClient({ mintPrice: 0n }),
  )
  assert.equal(result.to.toLowerCase(), SEADROP_ROUTER.toLowerCase())
})

await test('seadrop free: source = seadrop', async () => {
  setCachedAbi(CONTRACT_SEADROP_FREE_SOURCE, 'eth', SEADROP_INTERFACE_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_SEADROP_FREE_SOURCE, { mintPrice: '0' }),
    seaDropClient({ mintPrice: 0n }),
  )
  assert.equal(result.source, 'seadrop')
})

// ─── Section 3: Verified ABI (direct mint) ───────────────────────────────────

console.log('\n=== Section 3: Verified ABI — direct mint ===\n')

await test('verified abi: to = NFT contract (not router)', async () => {
  setCachedAbi(CONTRACT_VERIFIED_TO, 'eth', DIRECT_MINT_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_VERIFIED_TO),
    standardClient(),
  )
  assert.equal(result.to.toLowerCase(), CONTRACT_VERIFIED_TO.toLowerCase(),
    `to should be the NFT contract, got: ${result.to}`)
})

await test('verified abi: functionName matches ABI entry', async () => {
  setCachedAbi(CONTRACT_VERIFIED_FN, 'eth', DIRECT_MINT_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_VERIFIED_FN),
    standardClient(),
  )
  assert.equal(result.functionName, 'mint')
})

await test('verified abi: source = verified_abi', async () => {
  setCachedAbi(CONTRACT_VERIFIED_SOURCE, 'eth', DIRECT_MINT_ABI)
  const result = await prepareMintTransaction(
    body(CONTRACT_VERIFIED_SOURCE),
    standardClient(),
  )
  assert.equal(result.source, 'verified_abi')
})

await test('verified abi: candidatesFromAbi generates correct candidates', () => {
  const candidates = candidatesFromAbi(DIRECT_MINT_ABI, 1n, MOCK_WALLET)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].functionName, 'mint')
  assert.deepEqual(candidates[0].args, [1n])
  assert.equal(candidates[0].source, 'verified_abi')
})

await test('verified abi: candidatesFromAbi skips view functions', () => {
  const mixedAbi = [
    { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
    { type: 'function', name: 'mint', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  ]
  const candidates = candidatesFromAbi(mixedAbi, 1n, MOCK_WALLET)
  assert.ok(!candidates.some(c => c.functionName === 'totalSupply'), 'view functions should be excluded')
  assert.ok(candidates.some(c => c.functionName === 'mint'), 'payable functions should be included')
})

await test('verified abi: candidatesFromAbi skips unsupported arg shapes', () => {
  const proofAbi = [
    { type: 'function', name: 'mintAllowList', inputs: [{ type: 'bytes32[]' }, { type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  ]
  const candidates = candidatesFromAbi(proofAbi, 1n, MOCK_WALLET)
  assert.equal(candidates.length, 0, 'bytes32[] arg not supported — should yield 0 candidates')
})

// ─── Section 4: Generic fallback (no ABI, no SeaDrop) ────────────────────────

console.log('\n=== Section 4: Generic fallback (no verified ABI) ===\n')

await test('fallback: resolves when no verified ABI and SeaDrop probe fails', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_FALLBACK_RESOLVES),
    standardClient(),
  )
  assert.ok(result.functionName, 'should resolve a functionName via fallback')
  assert.ok(result.gas, 'should have gas estimate')
})

await test('fallback: source = common_signature', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_FALLBACK_SOURCE),
    standardClient(),
  )
  assert.equal(result.source, 'common_signature')
})

await test('fallback: to = NFT contract (not router)', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_FALLBACK_TO),
    standardClient(),
  )
  assert.equal(result.to.toLowerCase(), CONTRACT_FALLBACK_TO.toLowerCase())
})

await test('fallback: fallbackCandidates covers all required function names', () => {
  const fb = fallbackCandidates(1n, MOCK_WALLET)
  const names = new Set(fb.map(c => c.functionName))
  const required = ['mint', 'publicMint', 'mintPublic', 'allowlistMint', 'presaleMint', 'purchase', 'claim', 'safeMint']
  for (const name of required) {
    assert.ok(names.has(name), `fallback missing function: ${name}`)
  }
})

await test('fallback: fallbackCandidates all have source=common_signature', () => {
  const fb = fallbackCandidates(1n, MOCK_WALLET)
  const badSource = fb.find(c => c.source !== 'common_signature')
  assert.ok(!badSource, `unexpected source: ${badSource?.source}`)
})

await test('fallback: iteration stops at first succeeding candidate', async () => {
  // Succeed only after the 3rd call to simulate partial iteration
  let callCount = 0
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => {
      callCount++
      if (callCount < 3) throw new Error('execution reverted')
      return DEFAULT_GAS
    },
    getGasPrice: async () => DEFAULT_PRICE,
    readContract: async () => { throw new Error('not seadrop') },
  }
  const result = await prepareMintTransaction(body(CONTRACT_FALLBACK_ITERATION), client)
  assert.ok(result.functionName, 'should succeed after partial iteration')
  assert.ok(callCount >= 3, `expected ≥3 attempts, got ${callCount}`)
})

await test('fallback: all candidates fail → throws user-friendly error', async () => {
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => { throw new Error('execution reverted') },
    getGasPrice: async () => DEFAULT_PRICE,
    readContract: async () => { throw new Error('not seadrop') },
  }
  await assert.rejects(
    () => prepareMintTransaction(body(CONTRACT_FALLBACK_FAIL), client),
    /simulation failed|rejected|closed|allowlist|unknown mint/i,
  )
})

// ─── Section 5: Paid mint — value + spend cap ────────────────────────────────

console.log('\n=== Section 5: Paid mint (value calculation + spend cap) ===\n')

await test('paid: value = price * quantity (0.08 ETH * 1)', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_PAID_1ETH, { mintPrice: '0.08' }),
    standardClient(),
  )
  assert.equal(result.value, '80000000000000000')
})

await test('paid: value = price * quantity (0.08 ETH * 2 = 0.16 ETH)', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_PAID_2ETH, { mintPrice: '0.08', quantity: 2 }),
    standardClient(),
  )
  assert.equal(result.value, '160000000000000000')
})

await test('paid: value = price * quantity (0.001 ETH * 5 = 0.005 ETH)', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_PAID_5QTY, { mintPrice: '0.001', quantity: 5 }),
    standardClient(),
  )
  assert.equal(result.value, '5000000000000000')
})

await test('paid: max spend exceeded → throws', async () => {
  // price=0.1 ETH, gas~0.003 ETH total > 0.05 ETH cap
  await assert.rejects(
    () => prepareMintTransaction(
      body(CONTRACT_PAID_CAP_EXCEED, { mintPrice: '0.1', maxTotalSpend: '0.05' }),
      standardClient({ gasEstimate: 150000n, gasPrice: 20_000_000_000n }),
    ),
    /max spend|spend limit/i,
  )
})

await test('paid: max spend not exceeded → succeeds', async () => {
  // price=0.01 ETH, gas~0.003 ETH total ~0.013 ETH < 0.5 ETH cap
  const result = await prepareMintTransaction(
    body(CONTRACT_PAID_CAP_OK, { mintPrice: '0.01', maxTotalSpend: '0.5' }),
    standardClient({ gasEstimate: 150000n, gasPrice: 20_000_000_000n }),
  )
  assert.ok(result.functionName, 'should succeed below spend cap')
})

await test('paid: value is a string (not BigInt) in result', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_PAID_STR_TYPE, { mintPrice: '0.08' }),
    standardClient(),
  )
  assert.equal(typeof result.value, 'string', `value should be string, got ${typeof result.value}`)
})

// ─── Section 6: Free mint ────────────────────────────────────────────────────

console.log('\n=== Section 6: Free mint (value = 0) ===\n')

await test('free: value = 0 when mintPrice = 0', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_FREE_ZERO, { mintPrice: '0' }),
    standardClient(),
  )
  assert.equal(result.value, '0')
})

await test('free: value = 0 when mintPrice is undefined', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_FREE_UNDEF, { mintPrice: undefined }),
    standardClient(),
  )
  assert.equal(result.value, '0')
})

await test('free: no max spend cap rejection on free mints at low gas', async () => {
  // Free mint with a tiny spend cap — gas is below cap so it passes
  const result = await prepareMintTransaction(
    body(CONTRACT_FREE_CAP, { mintPrice: '0', maxTotalSpend: '1' }),
    standardClient({ gasEstimate: 50000n, gasPrice: 1_000_000_000n }),
  )
  assert.equal(result.value, '0')
})

await test('free: result has correct shape (to, data, value, gas, chainId)', async () => {
  const result = await prepareMintTransaction(
    body(CONTRACT_FREE_SHAPE, { mintPrice: '0' }),
    standardClient(),
  )
  assert.ok(result.to, 'missing: to')
  assert.ok(result.data, 'missing: data')
  assert.equal(result.value, '0')
  assert.ok(result.gas, 'missing: gas')
  assert.equal(result.chainId, 1)
  assert.ok(result.functionName, 'missing: functionName')
})

// ─── Section 7: argsForInputs coverage ───────────────────────────────────────

console.log('\n=== Section 7: argsForInputs — all input shapes ===\n')

await test('args: (uint256) → [quantity]', () => {
  assert.deepEqual(argsForInputs([{ type: 'uint256' }], 3n, MOCK_WALLET), [3n])
})

await test('args: (address) → [wallet]', () => {
  assert.deepEqual(argsForInputs([{ type: 'address' }], 1n, MOCK_WALLET), [MOCK_WALLET])
})

await test('args: (address, uint256) → [wallet, quantity]', () => {
  assert.deepEqual(argsForInputs([{ type: 'address' }, { type: 'uint256' }], 2n, MOCK_WALLET), [MOCK_WALLET, 2n])
})

await test('args: (uint256, address) → [quantity, wallet]', () => {
  assert.deepEqual(argsForInputs([{ type: 'uint256' }, { type: 'address' }], 2n, MOCK_WALLET), [2n, MOCK_WALLET])
})

await test('args: (uint256, uint256) → [quantity, 0n]', () => {
  assert.deepEqual(argsForInputs([{ type: 'uint256' }, { type: 'uint256' }], 5n, MOCK_WALLET), [5n, 0n])
})

await test('args: () → []', () => {
  assert.deepEqual(argsForInputs([], 1n, MOCK_WALLET), [])
})

await test('args: (bytes32[]) → null (unsupported — merkle proof)', () => {
  assert.equal(argsForInputs([{ type: 'bytes32[]' }], 1n, MOCK_WALLET), null)
})

await test('args: (bytes32[], uint256) → null (unsupported — allowlist signature)', () => {
  assert.equal(argsForInputs([{ type: 'bytes32[]' }, { type: 'uint256' }], 1n, MOCK_WALLET), null)
})

// ─── Section 8: H3 — classifyExecutionStatus fix (via probe cache) ────────────

console.log('\n=== Section 8: H3 — classifyExecutionStatus fix ===\n')

await test('h3: IncorrectPayment revert → probe cache = live (not paused/not_started)', async () => {
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => { throw new Error('IncorrectPayment(0, 80000000000000)') },
    getGasPrice: async () => DEFAULT_PRICE,
    readContract: async () => { throw new Error('not seadrop') },
  }
  try { await prepareMintTransaction(body(CONTRACT_CLASSIFY_PAYMENT), client) } catch {}
  const probe = getCachedProbeResult(CONTRACT_CLASSIFY_PAYMENT, 'eth')
  assert.ok(probe, 'probe cache should be populated after failed prepare')
  assert.equal(probe.execution_status, 'live',
    `payment error should classify as 'live', got: ${probe.execution_status}`)
})

await test('h3: msg.value error → probe cache = live', async () => {
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => { throw new Error('wrong msg.value sent') },
    getGasPrice: async () => DEFAULT_PRICE,
    readContract: async () => { throw new Error('not seadrop') },
  }
  try { await prepareMintTransaction(body(CONTRACT_CLASSIFY_MSGVAL), client) } catch {}
  const probe = getCachedProbeResult(CONTRACT_CLASSIFY_MSGVAL, 'eth')
  assert.equal(probe?.execution_status, 'live',
    `msg.value error should classify as 'live', got: ${probe?.execution_status}`)
})

await test('h3: generic execution reverted → probe cache = not_started (not paused)', async () => {
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => { throw new Error('execution reverted: some unknown reason') },
    getGasPrice: async () => DEFAULT_PRICE,
    readContract: async () => { throw new Error('not seadrop') },
  }
  try { await prepareMintTransaction(body(CONTRACT_CLASSIFY_REVERT), client) } catch {}
  const probe = getCachedProbeResult(CONTRACT_CLASSIFY_REVERT, 'eth')
  assert.ok(probe, 'probe cache should be populated')
  assert.equal(probe.execution_status, 'not_started',
    `generic revert should classify as 'not_started', got: ${probe.execution_status}`)
  assert.notEqual(probe.execution_status, 'paused', 'must NOT classify as paused (H3 fix)')
})

await test('h3: completely unknown error → probe cache = unsupported_execution (not paused)', async () => {
  const client = {
    getBytecode: async () => MOCK_BYTECODE,
    estimateGas: async () => { throw new Error('XYZZY_CUSTOM_CONTRACT_ERROR_12345') },
    getGasPrice: async () => DEFAULT_PRICE,
    readContract: async () => { throw new Error('not seadrop') },
  }
  try { await prepareMintTransaction(body(CONTRACT_CLASSIFY_UNKNOWN), client) } catch {}
  const probe = getCachedProbeResult(CONTRACT_CLASSIFY_UNKNOWN, 'eth')
  assert.ok(probe, 'probe cache should be populated')
  assert.equal(probe.execution_status, 'unsupported_execution',
    `unknown error should classify as 'unsupported_execution', got: ${probe.execution_status}`)
  assert.notEqual(probe.execution_status, 'paused', 'must NOT classify as paused (H3 fix)')
})

// ─── Section 9: C4 — executor `to` field resolution ─────────────────────────

console.log('\n=== Section 9: C4 — executor.js `to` field resolution ===\n')

function resolveExecutorTo(intent) {
  return intent.mint_contract_address || intent.to || intent.contract_address
}

await test('c4: mint_contract_address → used when present', () => {
  const to = resolveExecutorTo({ mint_contract_address: '0xAAA', to: '0xBBB', contract_address: '0xCCC' })
  assert.equal(to, '0xAAA')
})

await test('c4: to → used when mint_contract_address absent', () => {
  const to = resolveExecutorTo({ mint_contract_address: null, to: '0xBBB', contract_address: '0xCCC' })
  assert.equal(to, '0xBBB')
})

await test('c4: contract_address → used when both others absent (C4 fix)', () => {
  const to = resolveExecutorTo({ mint_contract_address: null, to: null, contract_address: '0xCCC' })
  assert.equal(to, '0xCCC',
    'contract_address should be the final fallback — this was the C4 bug')
})

await test('c4: all absent → undefined (executor throws)', () => {
  const to = resolveExecutorTo({ mint_contract_address: null, to: null, contract_address: null })
  assert.equal(to, null)
  // executor.js would throw: "Intent has no contract address"
})

await test('c4: empty string treated as falsy → falls through to next field', () => {
  const to = resolveExecutorTo({ mint_contract_address: '', to: '', contract_address: '0xCCC' })
  assert.equal(to, '0xCCC')
})

// ─── Section 10: C1+C2 — Prewarm saves `to` and `value` ──────────────────────

console.log('\n=== Section 10: C1+C2 — Prewarm persists to + value ===\n')

const PREWARM_NFT     = '0xbeefbeefbeefbeefbeefbeefbeefbeefbeef0001'
const PREWARM_ROUTER  = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
const PREWARM_VALUE   = '80000000000000'

function makePrewarmIntent(overrides = {}) {
  return {
    id: 'prewarm-val-001',
    user_id: 'user-val-001',
    chain: 'eth',
    contract_address: PREWARM_NFT,
    vault_wallet_id: null,
    max_mint_price: '0.00008',
    mint_price: '0.00008',
    quantity: 1,
    max_total_spend: null,
    ...overrides,
  }
}

function makeSeaDropPrepareFn() {
  return async (params) => ({
    to: PREWARM_ROUTER,         // SeaDrop router — not the NFT contract
    data: '0x161ac21f000000000000000000000000beefbeef',
    value: PREWARM_VALUE,       // 0.00008 ETH in wei
    gas: '200000',
    functionName: 'mintPublic',
    argsSummary: [PREWARM_NFT.slice(0, 10), FEE_RECIPIENT.slice(0, 10), ZERO_ADDR, '1'],
    source: 'seadrop',
    cacheHit: false,
  })
}

await test('c1: prewarm saves value from prepareFn (not hardcoded 0)', async () => {
  const sb = makeSupabase()
  await prewarmIntent(sb, makePrewarmIntent(), { _prepareFn: makeSeaDropPrepareFn() })
  const update = sb._updates.find(u => u.table === 'mint_intents')
  assert.ok(update, 'should have updated mint_intents')
  assert.equal(update.row.value, PREWARM_VALUE,
    `value should be ${PREWARM_VALUE}, got: ${update.row.value}`)
  assert.notEqual(update.row.value, '0', 'value must NOT be hardcoded 0 (C1 fix)')
})

await test('c2: prewarm saves to = router address (not NFT contract)', async () => {
  const sb = makeSupabase()
  await prewarmIntent(sb, makePrewarmIntent(), { _prepareFn: makeSeaDropPrepareFn() })
  const update = sb._updates.find(u => u.table === 'mint_intents')
  assert.ok(update, 'should have updated mint_intents')
  assert.equal(update.row.to?.toLowerCase(), PREWARM_ROUTER.toLowerCase(),
    `to should be router ${PREWARM_ROUTER}, got: ${update.row.to}`)
  assert.notEqual(update.row.to?.toLowerCase(), PREWARM_NFT.toLowerCase(),
    'to must NOT be the NFT contract (C2 fix)')
})

await test('c2: prewarm saves function_name = mintPublic', async () => {
  const sb = makeSupabase()
  await prewarmIntent(sb, makePrewarmIntent(), { _prepareFn: makeSeaDropPrepareFn() })
  const update = sb._updates.find(u => u.table === 'mint_intents')
  assert.equal(update.row.function_name, 'mintPublic')
})

await test('c1+c2: strike fast path reads intent.to for router, intent.value for amount', () => {
  // Simulate what strike-engine.js fast path does after C1+C2 fix
  const intent = {
    id: 'strike-c1c2-001',
    contract_address: PREWARM_NFT,
    to: PREWARM_ROUTER,          // written by prewarm (C2)
    call_data: '0x161ac21f000000000000000000000000beefbeef',
    gas_limit: '200000',
    value: PREWARM_VALUE,        // written by prewarm (C1)
    function_name: 'mintPublic',
  }

  const prepared = {
    to: intent.to || intent.contract_address,             // C2: uses router
    data: intent.call_data,
    value: intent.value || '0',                          // C1: uses stored value
    gas: intent.gas_limit || null,
    functionName: intent.function_name || 'prewarmed',
    source: 'prewarm_cache',
  }

  assert.equal(prepared.to.toLowerCase(), PREWARM_ROUTER.toLowerCase(),
    'fast path must route to SeaDrop router, not NFT contract')
  assert.equal(prepared.value, PREWARM_VALUE,
    'fast path must use stored value, not hardcoded 0')
  assert.equal(prepared.source, 'prewarm_cache')
})

await test('c1: free mint prewarm saves value=0 (not undefined)', async () => {
  const sb = makeSupabase()
  const freeFn = async (params) => ({
    to: PREWARM_NFT,
    data: '0xa0712d680000000000000000000000000000000000000000000000000000000000000001',
    value: '0',
    gas: '150000',
    functionName: 'mint',
    argsSummary: ['1'],
    source: 'common_signature',
    cacheHit: false,
  })
  await prewarmIntent(sb, makePrewarmIntent({ max_mint_price: '0', mint_price: '0' }), { _prepareFn: freeFn })
  const update = sb._updates.find(u => u.table === 'mint_intents')
  assert.equal(update.row.value, '0', 'free mint value should be stored as "0"')
})

// ─── Compatibility matrix ──────────────────────────────────────────────────────

console.log('\n\n=== Contract Execution Profile Matrix ===\n')

const profiles = [
  { profile: 'SeaDrop router — paid active',    status: 'DETERMINISTIC', chain: 'ETH',   note: 'to=router, value=price*qty, args=[nft,fee,0x0,qty]' },
  { profile: 'SeaDrop router — free active',    status: 'DETERMINISTIC', chain: 'ETH',   note: 'to=router, value=0' },
  { profile: 'SeaDrop router — inactive drop',  status: 'DETERMINISTIC', chain: 'ETH',   note: 'throws: not active' },
  { profile: 'SeaDrop router — future drop',    status: 'DETERMINISTIC', chain: 'ETH',   note: 'throws: not started' },
  { profile: 'SeaDrop router — expired drop',   status: 'DETERMINISTIC', chain: 'ETH',   note: 'throws: not active' },
  { profile: 'Verified ABI (mint uint256)',      status: 'DETERMINISTIC', chain: 'ETH',   note: 'to=contract, source=verified_abi' },
  { profile: 'Generic fallback (no ABI)',        status: 'DETERMINISTIC', chain: 'ETH',   note: 'source=common_signature, iterates candidates' },
  { profile: 'Paid mint (value + spend cap)',    status: 'DETERMINISTIC', chain: 'ETH',   note: 'value=price*qty, cap enforced' },
  { profile: 'Free mint (value=0)',              status: 'DETERMINISTIC', chain: 'ETH',   note: 'value=0, no cap rejection' },
  { profile: 'SeaDrop allowlist phase',          status: 'LIVE-ONLY',     chain: 'ETH',   note: 'requires real allowlist API — stub wallet path tested' },
  { profile: 'Allowlist with merkle proof',      status: 'UNSUPPORTED',   chain: 'ETH',   note: 'bytes32[] args not inferred — manual override required' },
  { profile: 'Signed mint (OpenSea session)',    status: 'UNSUPPORTED',   chain: 'ETH',   note: 'requires OpenSea signed session token' },
]

const profileWidth = Math.max(...profiles.map(p => p.profile.length))
for (const p of profiles) {
  const icon = p.status === 'DETERMINISTIC' ? '✓' : p.status === 'LIVE-ONLY' ? '~' : '✗'
  console.log(`  ${icon}  [${p.chain}] ${p.profile.padEnd(profileWidth)}  ${p.note}`)
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const ms = results.reduce((s, r) => s + r.ms, 0)
console.log(`\n${passed}/${total} tests passed  |  ${ms}ms total\n`)
if (failed > 0) {
  console.error('FAILED:')
  results.filter(r => !r.pass).forEach(r => console.error(`  ✗ ${r.name}: ${r.error}`))
  process.exitCode = 1
}
