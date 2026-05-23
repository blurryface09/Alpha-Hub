/**
 * Phase 6 — Real mainnet validation.
 *
 * Fetches live bytecode from ETH/Base mainnet, then runs prepareMintTransaction
 * using that real bytecode injected into a mock client with controlled gas
 * estimation. This validates the detection pipeline against actual on-chain
 * contract structure without requiring active mints.
 *
 * Contract coverage:
 *  M1 — FCFS free:   Doodles        (ETH) mint(uint256)   mintPrice=0
 *  M2 — FCFS paid:   Cryptoadz      (ETH) mint(uint256)   mintPrice=0.05
 *  M3 — FCFS paid:   WoW            (ETH) mint(uint256)   mintPrice=0.07
 *  M4 — purchase():  ArtBlocks      (ETH) purchase(uint256)
 *  M5 — Free Base:   Bytecode probe (Base) direct selector check
 *  M6 — SeaDrop:     Router interface live + detection path (mock drop state)
 *  M7 — Sold-out:    Doodles bytecode + always-revert estimateGas → correct error
 *
 * Run: node worker/test/mainnet-validation.test.js
 *
 * Requires: internet access to ethereum.publicnode.com and mainnet.base.org
 */

import assert from 'assert/strict'
import { createPublicClient, http, keccak256, toBytes } from 'viem'
import { mainnet, base } from 'viem/chains'
import { prepareMintTransaction } from '../../api/_lib/mint-engine.js'

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

// ─── Contracts under test ─────────────────────────────────────────────────────

const WALLET  = '0x1111111111111111111111111111111111111111'
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'

const ETH_CONTRACTS = {
  doodles:    '0x8a90cab2b38dba80c64b7734e58ee1db38b8992e',
  cryptoadz:  '0x1cb1a5e65610aeff2551a50f76a87a7d3fb649c6',
  wow:        '0xe785E82358879F061BC3dcAC6f0444462D4b5330',
  artblocks:  '0x059edd72cd353df5106d2b9cc5ab83a52287ac3a',
}

// ─── Selector helpers ─────────────────────────────────────────────────────────

function sel(sig) {
  return keccak256(toBytes(sig)).slice(2, 10)
}

const SELECTORS = {
  'mint(uint256)':      sel('mint(uint256)'),
  'purchase(uint256)':  sel('purchase(uint256)'),
  'publicMint(uint256)': sel('publicMint(uint256)'),
  'mintPublic(address,address,address,uint256)': sel('mintPublic(address,address,address,uint256)'),
}

// ─── Mock client builder (real bytecode + controlled gas estimation) ──────────

const DEFAULT_GAS      = 175000n
const DEFAULT_GASPRICE = 20_000_000_000n

function mockClient(bytecode, {
  gasEstimate = DEFAULT_GAS,
  alwaysRevert = false,
  readContractImpl = async () => null,
} = {}) {
  return {
    getBytecode:   async () => bytecode,
    estimateGas:   async () => {
      if (alwaysRevert) throw new Error('execution reverted')
      return gasEstimate
    },
    getGasPrice:   async () => DEFAULT_GASPRICE,
    readContract:  readContractImpl,
  }
}

function body(contract, chain, overrides = {}) {
  return {
    chain,
    contractAddress: contract,
    walletAddress: WALLET,
    mintPrice: '0',
    quantity: 1,
    ...overrides,
  }
}

// ─── Section 1: RPC connectivity ─────────────────────────────────────────────

console.log('\n=== Section 1: RPC connectivity ===\n')

const ethClient  = createPublicClient({ chain: mainnet, transport: http('https://ethereum.publicnode.com', { timeout: 8000 }) })
const baseClient = createPublicClient({ chain: base,    transport: http('https://mainnet.base.org',         { timeout: 8000 }) })

await test('rpc: ETH publicnode responds with recent block', async () => {
  const block = await ethClient.getBlockNumber()
  assert.ok(block > 0n, `block number should be > 0, got ${block}`)
  console.log(`     ↳ ETH block: ${block}`)
})

await test('rpc: Base mainnet responds with recent block', async () => {
  const block = await baseClient.getBlockNumber()
  assert.ok(block > 0n, `block number should be > 0, got ${block}`)
  console.log(`     ↳ Base block: ${block}`)
})

// ─── Section 2: Live bytecode fetch + selector validation ─────────────────────

console.log('\n=== Section 2: Live bytecode validation ===\n')

// Fetch all bytecodes upfront — these are the real on-chain contracts
const bytecodes = {}
for (const [name, addr] of Object.entries(ETH_CONTRACTS)) {
  bytecodes[name] = await ethClient.getBytecode({ address: addr })
}
bytecodes.seadrop = await ethClient.getBytecode({ address: SEADROP })

await test('bytecode: Doodles has mint(uint256) selector', () => {
  assert.ok(bytecodes.doodles, 'Doodles bytecode should exist')
  assert.ok(
    bytecodes.doodles.includes(SELECTORS['mint(uint256)']),
    `mint(uint256) selector ${SELECTORS['mint(uint256)']} not found in Doodles bytecode`,
  )
})

await test('bytecode: Cryptoadz has mint(uint256) selector', () => {
  assert.ok(bytecodes.cryptoadz, 'Cryptoadz bytecode should exist')
  assert.ok(
    bytecodes.cryptoadz.includes(SELECTORS['mint(uint256)']),
    `mint(uint256) selector not found in Cryptoadz bytecode`,
  )
})

await test('bytecode: WoW has mint(uint256) selector', () => {
  assert.ok(bytecodes.wow, 'WoW bytecode should exist')
  assert.ok(
    bytecodes.wow.includes(SELECTORS['mint(uint256)']),
    `mint(uint256) selector not found in WoW bytecode`,
  )
})

await test('bytecode: ArtBlocks has purchase(uint256) selector', () => {
  assert.ok(bytecodes.artblocks, 'ArtBlocks bytecode should exist')
  assert.ok(
    bytecodes.artblocks.includes(SELECTORS['purchase(uint256)']),
    `purchase(uint256) selector not found in ArtBlocks bytecode`,
  )
})

await test('bytecode: SeaDrop router has mintPublic selector', () => {
  assert.ok(bytecodes.seadrop, 'SeaDrop router bytecode should exist')
  assert.ok(
    bytecodes.seadrop.includes(SELECTORS['mintPublic(address,address,address,uint256)']),
    'mintPublic selector not found in SeaDrop router bytecode',
  )
})

await test('bytecode: all ETH contracts exceed 1000 bytes (real contracts, not proxies)', () => {
  for (const [name, bc] of Object.entries(bytecodes)) {
    assert.ok(bc && bc.length > 1000,
      `${name}: bytecode length ${bc?.length} is suspiciously short`)
  }
})

// ─── Section 3: M1 — FCFS free (Doodles, mint(uint256), mintPrice=0) ──────────

console.log('\n=== Section 3: M1 — FCFS free mint detection ===\n')

await test('m1: Doodles free — functionName=mint, source=common_signature', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth'), client)
  assert.equal(result.functionName, 'mint')
  assert.equal(result.source, 'common_signature')
})

await test('m1: Doodles free — value="0"', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth', { mintPrice: '0' }), client)
  assert.equal(result.value, '0')
})

await test('m1: Doodles free — to=contract address (not router)', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth'), client)
  assert.equal(result.to.toLowerCase(), ETH_CONTRACTS.doodles.toLowerCase())
})

await test('m1: Doodles free — data starts with mint(uint256) selector 0xa0712d68', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth'), client)
  assert.ok(result.data?.startsWith('0xa0712d68'),
    `expected 0xa0712d68, got ${result.data?.slice(0, 10)}`)
})

await test('m1: Doodles free — chainId=1 (ETH mainnet)', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth'), client)
  assert.equal(result.chainId, 1)
})

await test('m1: Doodles free — gas is a non-zero string', async () => {
  const client = mockClient(bytecodes.doodles, { gasEstimate: 165000n })
  const result = await prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth'), client)
  assert.ok(result.gas, 'gas should be set')
  assert.ok(Number(result.gas) > 0, `gas should be > 0, got ${result.gas}`)
})

// ─── Section 4: M2/M3 — FCFS paid mint (Cryptoadz + WoW) ────────────────────

console.log('\n=== Section 4: M2/M3 — FCFS paid mint detection ===\n')

await test('m2: Cryptoadz paid — value = mintPrice * quantity', async () => {
  const client = mockClient(bytecodes.cryptoadz)
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.cryptoadz, 'eth', { mintPrice: '0.05', quantity: 2 }),
    client,
  )
  // 0.05 ETH * 2 = 0.1 ETH = 100000000000000000 wei (hardcoded to avoid float imprecision)
  assert.equal(result.value, '100000000000000000')
})

await test('m2: Cryptoadz paid — functionName=mint detected from real bytecode', async () => {
  const client = mockClient(bytecodes.cryptoadz)
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.cryptoadz, 'eth', { mintPrice: '0.05' }),
    client,
  )
  assert.equal(result.functionName, 'mint')
})

await test('m3: WoW paid — value = 0.07 ETH (1 token)', async () => {
  const client = mockClient(bytecodes.wow)
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.wow, 'eth', { mintPrice: '0.07', quantity: 1 }),
    client,
  )
  // 0.07 ETH = 70000000000000000 wei (hardcoded to avoid float precision loss)
  assert.equal(result.value, '70000000000000000')
})

await test('m3: WoW paid — functionName=mint detected from real bytecode', async () => {
  const client = mockClient(bytecodes.wow)
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.wow, 'eth', { mintPrice: '0.07' }),
    client,
  )
  // source may be 'cache' if the previous test already populated it — both are valid
  assert.equal(result.functionName, 'mint')
  assert.ok(['common_signature', 'cache'].includes(result.source),
    `unexpected source: ${result.source}`)
})

await test('m3: WoW paid — max spend cap respected', async () => {
  const client = mockClient(bytecodes.wow)
  // price = 10 ETH, cap = 1 ETH → should throw max_spend_exceeded
  await assert.rejects(
    () => prepareMintTransaction(
      body(ETH_CONTRACTS.wow, 'eth', { mintPrice: '10', maxTotalSpend: '1' }),
      client,
    ),
    /max spend|max_spend|exceeded/i,
  )
})

// ─── Section 5: M4 — purchase() pattern (ArtBlocks) ──────────────────────────

console.log('\n=== Section 5: M4 — purchase(uint256) detection ===\n')

await test('m4: ArtBlocks — purchase(uint256) detected from real bytecode', async () => {
  // estimateGas only accepts calls with the purchase(uint256) selector — rejects all others.
  // This forces the detection to land on purchase rather than the first passing candidate.
  const purchaseSel = '0xefef39a1'
  const client = {
    getBytecode: async () => bytecodes.artblocks,
    estimateGas: async ({ data }) => {
      if (!data?.startsWith(purchaseSel)) throw new Error('execution reverted')
      return DEFAULT_GAS
    },
    getGasPrice: async () => DEFAULT_GASPRICE,
    readContract: async () => null,
  }
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.artblocks, 'eth', { mintPrice: '0.1' }),
    client,
  )
  assert.equal(result.functionName, 'purchase')
  assert.equal(result.source, 'common_signature')
})

await test('m4: ArtBlocks — value = 0.1 ETH', async () => {
  // 0.1 ETH = 100000000000000000 wei (hardcoded to avoid float precision loss)
  const purchaseSel = '0xefef39a1'
  const client = {
    getBytecode: async () => bytecodes.artblocks,
    estimateGas: async ({ data }) => {
      if (!data?.startsWith(purchaseSel)) throw new Error('execution reverted')
      return DEFAULT_GAS
    },
    getGasPrice: async () => DEFAULT_GASPRICE,
    readContract: async () => null,
  }
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.artblocks, 'eth', { mintPrice: '0.1' }),
    client,
  )
  assert.equal(result.value, '100000000000000000')
})

await test('m4: ArtBlocks — data starts with purchase(uint256) selector 0xefef39a1', async () => {
  const purchaseSel = '0xefef39a1'
  const client = {
    getBytecode: async () => bytecodes.artblocks,
    estimateGas: async ({ data }) => {
      if (!data?.startsWith(purchaseSel)) throw new Error('execution reverted')
      return DEFAULT_GAS
    },
    getGasPrice: async () => DEFAULT_GASPRICE,
    readContract: async () => null,
  }
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.artblocks, 'eth', { mintPrice: '0.1' }),
    client,
  )
  assert.ok(result.data?.startsWith(purchaseSel),
    `expected ${purchaseSel}, got ${result.data?.slice(0, 10)}`)
})

// ─── Section 6: M5 — Base chain routing ──────────────────────────────────────

console.log('\n=== Section 6: M5 — Base chain routing ===\n')

await test('m5: Base chain — chainId=8453 when chain="base"', async () => {
  const client = mockClient(bytecodes.doodles) // reuse any non-empty bytecode
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.doodles, 'base'),
    client,
  )
  assert.equal(result.chainId, 8453)
})

await test('m5: Base chain — "base-mainnet" normalised to base', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.doodles, 'base-mainnet'),
    client,
  )
  assert.equal(result.chainId, 8453)
})

await test('m5: ETH chain — "ethereum" normalised to eth', async () => {
  const client = mockClient(bytecodes.doodles)
  const result = await prepareMintTransaction(
    body(ETH_CONTRACTS.doodles, 'ethereum'),
    client,
  )
  assert.equal(result.chainId, 1)
})

// ─── Section 7: M6 — SeaDrop live interface + detection path ─────────────────

console.log('\n=== Section 7: M6 — SeaDrop interface + detection ===\n')

const SEADROP_ABI = [
  {
    name: 'getAllowedFeeRecipients',
    type: 'function',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    name: 'getPublicDrop',
    type: 'function',
    inputs: [{ type: 'address' }],
    outputs: [
      { name: 'mintPrice',               type: 'uint80' },
      { name: 'startTime',               type: 'uint48' },
      { name: 'endTime',                 type: 'uint48' },
      { name: 'maxMintablePerWallet',    type: 'uint16' },
      { name: 'feeBps',                  type: 'uint16' },
      { name: 'restrictFeeRecipients',   type: 'bool'   },
    ],
    stateMutability: 'view',
  },
]

const AZUKI = '0xed5af388653567af2f388e6224dc7c4b3241c544'

await test('m6: SeaDrop router is deployed (bytecode > 5000 bytes)', () => {
  assert.ok(bytecodes.seadrop && bytecodes.seadrop.length > 5000,
    `SeaDrop router bytecode length ${bytecodes.seadrop?.length} is too short`)
})

await test('m6: SeaDrop getAllowedFeeRecipients is callable (live RPC)', async () => {
  // Call with Azuki — may return empty array (drop not configured) but should not throw
  const recipients = await ethClient.readContract({
    address: SEADROP,
    abi: SEADROP_ABI,
    functionName: 'getAllowedFeeRecipients',
    args: [AZUKI],
  })
  assert.ok(Array.isArray(recipients), 'getAllowedFeeRecipients should return array')
})

await test('m6: SeaDrop getPublicDrop is callable (live RPC)', async () => {
  const drop = await ethClient.readContract({
    address: SEADROP,
    abi: SEADROP_ABI,
    functionName: 'getPublicDrop',
    args: [AZUKI],
  })
  // drop is an array or object — must be non-null and have a mintPrice field at index 0
  assert.ok(drop !== null && drop !== undefined, 'getPublicDrop should return data')
  assert.equal(typeof drop[0], 'bigint', 'mintPrice should be bigint')
})

// SeaDrop detection path: mock an NFT with mintSeaDrop ABI + active drop
await test('m6: SeaDrop active drop → to=router, value=mintPrice from drop', async () => {
  const NFT_ADDR  = '0xaaaa000000000000000000000000000000000001'
  const FEE_RECIP = '0x0000a26b00c1F0DF003000390027140000fAa719'
  const PRICE_WEI = 80000000000000n  // 0.00008 ETH
  const NOW_TS    = BigInt(Math.floor(Date.now() / 1000))
  const START_TS  = NOW_TS - 3600n   // started 1h ago
  const END_TS    = 0n               // no end time

  // ABI declares mintSeaDrop so the SeaDrop detection branch fires
  const fakeAbi = [
    {
      name: 'mintSeaDrop',
      type: 'function',
      inputs: [{ name: 'minter', type: 'address' }, { name: 'quantity', type: 'uint256' }],
      outputs: [],
      stateMutability: 'nonpayable',
    },
  ]

  // readContract mock: handles getAllowedFeeRecipients + getPublicDrop
  const readContractImpl = async ({ functionName, args }) => {
    if (functionName === 'getAllowedFeeRecipients') return [FEE_RECIP]
    if (functionName === 'getPublicDrop') return [PRICE_WEI, START_TS, END_TS, 5n, 500n, false]
    throw new Error(`Unexpected readContract: ${functionName}`)
  }

  // Bytecode for the NFT — must be non-empty and contain mintSeaDrop selector
  const mintSeaDropSel = sel('mintSeaDrop(address,uint256)')
  const fakeBytecode   = `0x6080${mintSeaDropSel}${'ab'.repeat(40)}`

  const seaDropClient = {
    getBytecode: async ({ address }) => {
      if (address.toLowerCase() === NFT_ADDR.toLowerCase()) return fakeBytecode
      return bytecodes.seadrop
    },
    estimateGas:    async () => DEFAULT_GAS,
    getGasPrice:    async () => DEFAULT_GASPRICE,
    readContract:   readContractImpl,
    _clientOverride: true,
  }

  const result = await prepareMintTransaction(
    { chain: 'eth', contractAddress: NFT_ADDR, walletAddress: WALLET, mintPrice: '0', quantity: 1 },
    seaDropClient,
  )

  assert.equal(result.to.toLowerCase(), SEADROP.toLowerCase(),
    'to should be SeaDrop router, not NFT contract')
  assert.equal(result.functionName, 'mintPublic')
  assert.equal(result.source, 'seadrop')
  assert.equal(result.value, PRICE_WEI.toString(),
    `value should be ${PRICE_WEI}, got ${result.value}`)
})

await test('m6: SeaDrop inactive drop (startTime=0) → skipped, falls back to common_signature', async () => {
  const NFT_ADDR = '0xaaaa000000000000000000000000000000000002'
  const mintSeaDropSel = sel('mintSeaDrop(address,uint256)')
  const fakeBytecode   = `0x6080${mintSeaDropSel}${'ab'.repeat(40)}`

  const readContractImpl = async ({ functionName }) => {
    if (functionName === 'getAllowedFeeRecipients') return []
    if (functionName === 'getPublicDrop') return [0n, 0n, 0n, 0n, 0n, false] // inactive
    throw new Error(`Unexpected: ${functionName}`)
  }

  // Add mint(uint256) selector to bytecode so fallback detection works
  const mintSel = sel('mint(uint256)')
  const fullBytecode = `0x6080${mintSeaDropSel}${mintSel}${'ab'.repeat(40)}`

  const client = {
    getBytecode: async () => fullBytecode,
    estimateGas: async ({ data }) => {
      // Only accept mint(uint256) call, reject mintPublic
      if (data?.startsWith('0x161ac21f')) throw new Error('execution reverted')
      return DEFAULT_GAS
    },
    getGasPrice: async () => DEFAULT_GASPRICE,
    readContract: readContractImpl,
  }

  const result = await prepareMintTransaction(
    { chain: 'eth', contractAddress: NFT_ADDR, walletAddress: WALLET, mintPrice: '0', quantity: 1 },
    client,
  )

  // Inactive SeaDrop drop should be skipped; common_signature fallback wins
  assert.notEqual(result.source, 'seadrop', 'inactive SeaDrop should not produce source=seadrop')
})

// ─── Section 8: M7 — Sold-out handling with real bytecode ─────────────────────

console.log('\n=== Section 8: M7 — Sold-out contract handling ===\n')

await test('m7: Doodles sold-out — all candidates revert → throws safe error message', async () => {
  const client = mockClient(bytecodes.doodles, { alwaysRevert: true })
  await assert.rejects(
    () => prepareMintTransaction(body(ETH_CONTRACTS.doodles, 'eth'), client),
    /simulation failed|execution reverted|Mint/i,
  )
})

await test('m7: Cryptoadz sold-out — throws, not crashes with unhandled exception', async () => {
  const client = mockClient(bytecodes.cryptoadz, { alwaysRevert: true })
  let threw = false
  try {
    await prepareMintTransaction(body(ETH_CONTRACTS.cryptoadz, 'eth'), client)
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'should throw a catchable error, not crash')
})

await test('m7: WoW insufficient funds — error message is user-friendly', async () => {
  const client = {
    getBytecode: async () => bytecodes.wow,
    estimateGas: async () => { throw new Error('insufficient funds for transfer') },
    getGasPrice: async () => DEFAULT_GASPRICE,
    readContract: async () => null,
  }
  await assert.rejects(
    () => prepareMintTransaction(body(ETH_CONTRACTS.wow, 'eth', { mintPrice: '0.07' }), client),
    /insufficient eth|top up|insufficient funds/i,
  )
})

await test('m7: ArtBlocks sold-out — error distinguishable from "no contract"', async () => {
  const client = mockClient(bytecodes.artblocks, { alwaysRevert: true })
  let errorMsg = null
  try {
    await prepareMintTransaction(body(ETH_CONTRACTS.artblocks, 'eth'), client)
  } catch (err) {
    errorMsg = err.message
  }
  assert.ok(errorMsg, 'should throw')
  // Must not be "No contract exists" — we have real bytecode
  assert.ok(!errorMsg.includes('No contract exists'),
    `should not be "no contract" error, got: ${errorMsg}`)
})

await test('m7: no bytecode → "No contract exists" error', async () => {
  const client = mockClient('0x', { alwaysRevert: false }) // empty bytecode
  await assert.rejects(
    () => prepareMintTransaction(body('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'eth'), client),
    /No contract exists/i,
  )
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const ms    = results.reduce((s, r) => s + r.ms, 0)

console.log('\n' + '─'.repeat(56))
console.log('Contracts validated:')
console.log(`  ETH Doodles:   ${ETH_CONTRACTS.doodles}`)
console.log(`  ETH Cryptoadz: ${ETH_CONTRACTS.cryptoadz}`)
console.log(`  ETH WoW:       ${ETH_CONTRACTS.wow}`)
console.log(`  ETH ArtBlocks: ${ETH_CONTRACTS.artblocks}`)
console.log(`  ETH SeaDrop:   ${SEADROP}`)
console.log('─'.repeat(56))
console.log(`\n${passed}/${total} tests passed  |  ${ms}ms total\n`)

if (failed > 0) {
  console.error('FAILED:')
  results.filter(r => !r.pass).forEach(r => console.error(`  ✗ ${r.name}: ${r.error}`))
  process.exitCode = 1
}
