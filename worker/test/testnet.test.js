/**
 * Testnet execution harness tests.
 * Run: node worker/test/testnet.test.js
 *
 * Covers:
 *  - Mainnet chain ID rejection
 *  - Testnet allowlist enforcement
 *  - Nonce tracking flow
 *  - Replacement tx (gas escalation on retry)
 *  - Receipt field persistence
 */

import assert from 'assert/strict'
import {
  assertNotMainnet,
  assertTestnetOnly,
  normalizeTestnetChain,
  isMainnetChainId,
  getTestnetChain,
  getTestnetRpcUrls,
  getExplorerTxLink,
  getExplorerAddressLink,
  MAINNET_CHAIN_IDS,
  TESTNET_CHAINS,
} from '../lib/testnet.js'
import { sendAndConfirm }   from '../lib/testnet-executor.js'
import { nonceTracker }     from '../lib/retry.js'

// ─── Mainnet rejection ────────────────────────────────────────────────────────

{
  for (const id of [1, 8453, 56, 33139, 137, 42161, 10]) {
    assert.throws(
      () => assertNotMainnet(id),
      /mainnet chain/,
      `assertNotMainnet should throw for chain ID ${id}`,
    )
  }
  console.log('✓ assertNotMainnet throws for all known mainnet chain IDs')
}

{
  // Testnet IDs must not throw
  assert.doesNotThrow(() => assertNotMainnet(11155111))
  assert.doesNotThrow(() => assertNotMainnet(84532))
  console.log('✓ assertNotMainnet passes for Sepolia and Base Sepolia chain IDs')
}

{
  // Strings also work
  assert.throws(() => assertNotMainnet('1'),    /mainnet chain/)
  assert.throws(() => assertNotMainnet('8453'), /mainnet chain/)
  assert.doesNotThrow(() => assertNotMainnet('11155111'))
  console.log('✓ assertNotMainnet handles string chain IDs')
}

// ─── Allowlist enforcement ────────────────────────────────────────────────────

{
  assert.doesNotThrow(() => assertTestnetOnly('sepolia'))
  assert.doesNotThrow(() => assertTestnetOnly('base-sepolia'))
  console.log('✓ assertTestnetOnly passes for sepolia and base-sepolia')
}

{
  assert.throws(() => assertTestnetOnly(null),         /null or unrecognized/)
  assert.throws(() => assertTestnetOnly(undefined),    /null or unrecognized/)
  assert.throws(() => assertTestnetOnly('polygon'),    /not in the testnet execution allowlist/)
  assert.throws(() => assertTestnetOnly('arbitrum'),   /not in the testnet execution allowlist/)
  assert.throws(() => assertTestnetOnly('unknown-net'), /not in the testnet execution allowlist/)
  console.log('✓ assertTestnetOnly throws for null and unknown chains')
}

{
  // Mainnet-aliased keys normalize to testnet, so assertTestnetOnly('sepolia') passes
  const key = normalizeTestnetChain('eth')
  assert.equal(key, 'sepolia')
  assert.doesNotThrow(() => assertTestnetOnly(key))
  console.log('✓ normalizeTestnetChain maps eth → sepolia (testnet redirect)')
}

{
  const key = normalizeTestnetChain('base')
  assert.equal(key, 'base-sepolia')
  assert.doesNotThrow(() => assertTestnetOnly(key))
  console.log('✓ normalizeTestnetChain maps base → base-sepolia (testnet redirect)')
}

{
  assert.equal(normalizeTestnetChain('sepolia'),        'sepolia')
  assert.equal(normalizeTestnetChain('base-sepolia'),   'base-sepolia')
  assert.equal(normalizeTestnetChain('11155111'),       'sepolia')
  assert.equal(normalizeTestnetChain('84532'),          'base-sepolia')
  assert.equal(normalizeTestnetChain('unknown'),        null)
  assert.equal(normalizeTestnetChain(''),               null)
  console.log('✓ normalizeTestnetChain covers all input variants')
}

// ─── Chain metadata ───────────────────────────────────────────────────────────

{
  const chain = getTestnetChain('sepolia')
  assert.equal(chain.id, 11155111)
  assert.equal(chain.testnet, true)
  assert.ok(chain.blockExplorers.default.url.includes('sepolia.etherscan.io'))
  console.log('✓ getTestnetChain returns correct Sepolia descriptor')
}

{
  const chain = getTestnetChain('base-sepolia')
  assert.equal(chain.id, 84532)
  assert.ok(chain.blockExplorers.default.url.includes('basescan.org'))
  console.log('✓ getTestnetChain returns correct Base Sepolia descriptor')
}

{
  assert.throws(() => getTestnetChain('polygon'), /Unknown testnet chain/)
  console.log('✓ getTestnetChain throws for unknown chain')
}

// ─── Explorer links ───────────────────────────────────────────────────────────

{
  const hash = '0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678'
  const link = getExplorerTxLink('sepolia', hash)
  assert.ok(link.startsWith('https://sepolia.etherscan.io/tx/'))
  assert.ok(link.endsWith(hash))
  console.log('✓ getExplorerTxLink builds correct Sepolia tx URL')
}

{
  const hash = '0xabcdef'
  const link = getExplorerTxLink('base-sepolia', hash)
  assert.ok(link.includes('sepolia.basescan.org'))
  console.log('✓ getExplorerTxLink builds correct Base Sepolia tx URL')
}

{
  assert.equal(getExplorerTxLink('sepolia', null), null)
  assert.equal(getExplorerTxLink('unknown', '0xabc'), null)
  console.log('✓ getExplorerTxLink returns null for missing inputs')
}

{
  const addr = '0x1234567890123456789012345678901234567890'
  const link = getExplorerAddressLink('sepolia', addr)
  assert.ok(link.includes('/address/'))
  assert.ok(link.includes(addr))
  console.log('✓ getExplorerAddressLink builds correct address URL')
}

// ─── RPC URLs ─────────────────────────────────────────────────────────────────

{
  const urls = getTestnetRpcUrls('sepolia')
  assert.ok(urls.length >= 1)
  assert.ok(urls.some(u => u.includes('sepolia')))
  console.log('✓ getTestnetRpcUrls returns at least one Sepolia URL')
}

{
  const urls = getTestnetRpcUrls('base-sepolia')
  assert.ok(urls.length >= 1)
  assert.ok(urls.some(u => u.includes('base') || u.includes('sepolia')))
  console.log('✓ getTestnetRpcUrls returns at least one Base Sepolia URL')
}

// ─── Nonce flow ───────────────────────────────────────────────────────────────

{
  // Nonce is undefined before set
  const addr = '0xNonceTestAddr0000000000000000000000001'
  nonceTracker.clear(addr)
  assert.equal(nonceTracker.get(addr), undefined)

  nonceTracker.set(addr, 10)
  assert.equal(nonceTracker.get(addr), 10)

  nonceTracker.increment(addr)
  assert.equal(nonceTracker.get(addr), 11)

  nonceTracker.increment(addr)
  assert.equal(nonceTracker.get(addr), 12)

  nonceTracker.clear(addr)
  assert.equal(nonceTracker.get(addr), undefined)
  console.log('✓ nonceTracker get/set/increment/clear flow')
}

{
  // nonceTracker.increment is a no-op when address is not tracked
  const addr = '0xUnknownAddr0000000000000000000000000001'
  nonceTracker.clear(addr)
  assert.doesNotThrow(() => nonceTracker.increment(addr))
  assert.equal(nonceTracker.get(addr), undefined)
  console.log('✓ nonceTracker.increment is safe when address is untracked')
}

// ─── sendAndConfirm — successful path ────────────────────────────────────────

{
  const walletAddr = '0xTestWallet00000000000000000000000000001'
  nonceTracker.clear(walletAddr)

  const mockPublicClient = {
    getTransactionCount: async () => 5,
    waitForTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      gasUsed: 21000n,
      transactionHash: '0xhashA',
    }),
  }
  const mockWalletClient = {
    chain:   { id: 11155111 }, // Sepolia — passes assertNotMainnet
    account: { address: walletAddr },
    sendTransaction: async () => '0xhashA',
  }
  const gasParams = {
    isEip1559:            true,
    maxFeePerGas:         30_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
    strategy:             'balanced',
    baseFeeGwei:          15,
  }

  const result = await sendAndConfirm(
    mockWalletClient,
    mockPublicClient,
    { to: '0xcontract', data: '0x', value: 0n, nonce: 5 },
    { gasParams, receiptTimeoutMs: 5_000 },
  )

  assert.equal(result.txHash, '0xhashA')
  assert.equal(result.receipt.status, 'success')
  assert.equal(result.receipt.blockNumber, 100n)
  assert.equal(result.receipt.gasUsed, 21000n)
  console.log('✓ sendAndConfirm succeeds on first attempt')
}

// ─── sendAndConfirm — mainnet wallet rejected ────────────────────────────────

{
  const mockWalletClient = {
    chain:   { id: 1 }, // Mainnet — must be rejected
    account: { address: '0xMainnetWallet' },
    sendTransaction: async () => '0xneverreached',
  }
  await assert.rejects(
    () => sendAndConfirm(mockWalletClient, {}, { to: '0x', data: '0x', value: 0n, nonce: 0 }, {
      gasParams: { isEip1559: true, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    }),
    /mainnet chain/,
  )
  console.log('✓ sendAndConfirm hard-rejects mainnet wallet chain ID')
}

// ─── sendAndConfirm — replacement tx on gas_too_low ──────────────────────────

{
  const walletAddr = '0xReplacement00000000000000000000000001'
  nonceTracker.clear(walletAddr)

  let callCount     = 0
  let lastMaxFee    = 0n
  let firstMaxFee   = 0n

  const mockPublicClient = {
    getTransactionCount: async () => 7,
    waitForTransactionReceipt: async () => ({
      status: 'success', blockNumber: 200n, gasUsed: 21000n,
    }),
  }
  const mockWalletClient = {
    chain:   { id: 11155111 },
    account: { address: walletAddr },
    sendTransaction: async ({ maxFeePerGas }) => {
      callCount++
      if (callCount === 1) {
        firstMaxFee = maxFeePerGas
        throw new Error('transaction underpriced')
      }
      lastMaxFee = maxFeePerGas
      return '0xhashReplaced'
    },
  }
  const gasParams = {
    isEip1559: true,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
    strategy: 'balanced',
    baseFeeGwei: 15,
  }

  const result = await sendAndConfirm(
    mockWalletClient,
    mockPublicClient,
    { to: '0xcontract', data: '0x', value: 0n, nonce: 7 },
    { gasParams, maxRetries: 3, receiptTimeoutMs: 5_000 },
  )

  assert.equal(result.txHash, '0xhashReplaced')
  assert.equal(callCount, 2)
  // Replacement tx must have higher maxFeePerGas (≥10% per EIP-1559 rules)
  assert.ok(lastMaxFee > firstMaxFee, 'replacement tx maxFeePerGas must exceed original')
  const ratio = Number(lastMaxFee) / Number(firstMaxFee)
  assert.ok(ratio >= 1.10, `gas escalation ratio ${ratio.toFixed(3)} must be ≥1.10`)
  console.log(`✓ replacement tx gas escalated by ${((ratio - 1) * 100).toFixed(1)}% (≥10% required)`)
}

// ─── sendAndConfirm — nonce refreshed on each retry ──────────────────────────

{
  const walletAddr  = '0xNonceRefresh00000000000000000000001'
  nonceTracker.clear(walletAddr)

  let nonceFetchCount = 0
  let lastNonceUsed   = -1

  const mockPublicClient = {
    getTransactionCount: async () => { nonceFetchCount++; return 20 + nonceFetchCount },
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 300n, gasUsed: 21000n }),
  }
  const mockWalletClient = {
    chain:   { id: 11155111 },
    account: { address: walletAddr },
    sendTransaction: async ({ nonce }) => {
      lastNonceUsed = nonce
      if (nonceFetchCount < 2) throw new Error('nonce too low')
      return '0xhashNonce'
    },
  }
  const gasParams = {
    isEip1559: true,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
    strategy: 'balanced',
    baseFeeGwei: 15,
  }

  await sendAndConfirm(
    mockWalletClient,
    mockPublicClient,
    { to: '0xcontract', data: '0x', value: 0n, nonce: 20 },
    { gasParams, maxRetries: 3, receiptTimeoutMs: 5_000 },
  )

  assert.ok(nonceFetchCount >= 1, 'nonce was refreshed from chain on retry')
  assert.ok(lastNonceUsed > 20, 'final tx used refreshed nonce')
  console.log(`✓ nonce refreshed from chain on retry (fetched ${nonceFetchCount}×, final nonce: ${lastNonceUsed})`)
}

// ─── sendAndConfirm — non-retryable error propagates immediately ──────────────

{
  const mockWalletClient = {
    chain:   { id: 11155111 },
    account: { address: '0xRevertTest000000000000000000000001' },
    sendTransaction: async () => { throw new Error('execution reverted: insufficient tokens') },
  }
  const mockPublicClient = {
    getTransactionCount: async () => 1,
    waitForTransactionReceipt: async () => {},
  }
  let callCount = 0
  const trackingClient = {
    ...mockWalletClient,
    sendTransaction: async () => { callCount++; throw new Error('execution reverted') },
  }

  await assert.rejects(
    () => sendAndConfirm(
      trackingClient, mockPublicClient,
      { to: '0x', data: '0x', value: 0n, nonce: 1 },
      { gasParams: { isEip1559: true, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, maxRetries: 3 },
    ),
    /revert/i,
  )
  assert.equal(callCount, 1, 'should not retry on revert')
  console.log('✓ revert error is non-retryable — no retry loop entered')
}

// ─── Receipt field persistence ────────────────────────────────────────────────

{
  // Verify that the receipt fields (blockNumber, gasUsed, status) are returned
  // correctly and available for DB persistence.
  const mockPublicClient = {
    getTransactionCount: async () => 99,
    waitForTransactionReceipt: async () => ({
      status:          'success',
      blockNumber:     999n,
      gasUsed:         55_000n,
      transactionHash: '0xreceiptHash',
    }),
  }
  const mockWalletClient = {
    chain:   { id: 84532 }, // Base Sepolia
    account: { address: '0xReceiptTest000000000000000000000001' },
    sendTransaction: async () => '0xreceiptHash',
  }
  const gasParams = {
    isEip1559: true,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
    strategy: 'balanced',
    baseFeeGwei: 10,
  }

  const result = await sendAndConfirm(
    mockWalletClient,
    mockPublicClient,
    { to: '0xcontract', data: '0x', value: 0n, nonce: 99 },
    { gasParams, receiptTimeoutMs: 5_000 },
  )

  assert.equal(result.txHash, '0xreceiptHash')
  assert.equal(result.receipt.status, 'success')
  assert.equal(result.receipt.blockNumber, 999n)
  assert.equal(result.receipt.gasUsed, 55_000n)

  // Simulate how executor persists receipt to DB
  const blockNumber = result.receipt.blockNumber.toString()
  const gasUsed     = result.receipt.gasUsed.toString()
  assert.equal(blockNumber, '999')
  assert.equal(gasUsed, '55000')

  console.log('✓ receipt fields (status, blockNumber, gasUsed) available for DB persistence')
}

// ─── sendAndConfirm — onSubmit and onRetry callbacks ─────────────────────────

{
  const submitLog = []
  const retryLog  = []
  let callCount   = 0

  const mockPublicClient = {
    getTransactionCount: async () => 50,
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 400n, gasUsed: 21000n }),
  }
  const mockWalletClient = {
    chain:   { id: 11155111 },
    account: { address: '0xCallbackTest0000000000000000000001' },
    sendTransaction: async () => {
      callCount++
      if (callCount === 1) throw new Error('transaction underpriced')
      return '0xcallbackHash'
    },
  }
  const gasParams = {
    isEip1559: true,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
    strategy: 'balanced',
    baseFeeGwei: 15,
  }

  await sendAndConfirm(
    mockWalletClient,
    mockPublicClient,
    { to: '0xcontract', data: '0x', value: 0n, nonce: 50 },
    {
      gasParams,
      maxRetries: 3,
      receiptTimeoutMs: 5_000,
      onSubmit: async (hash, attempt) => submitLog.push({ hash, attempt }),
      onRetry:  async (attempt, err, c) => retryLog.push({ attempt, type: c.type }),
    },
  )

  assert.equal(submitLog.length, 1)
  assert.equal(submitLog[0].hash, '0xcallbackHash')
  assert.equal(retryLog.length, 1)
  assert.equal(retryLog[0].attempt, 0)
  assert.equal(retryLog[0].type, 'gas_too_low') // 'transaction underpriced' maps to gas_too_low
  console.log('✓ onSubmit and onRetry callbacks are invoked correctly')
}

console.log('\nAll testnet tests passed.')
