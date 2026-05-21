/**
 * End-to-end live mint test on Sepolia.
 * Runs: prepare → submit TX → wait for receipt → verify supply.
 *
 * Run: node worker/test/live-mint-e2e.test.mjs
 */

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { prepareMintTransaction } from '../../api/_lib/mint-engine.js'

const RPC       = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const PRIV_KEY  = process.env.DEPLOY_PRIVATE_KEY || '0x60eaa4066e49c578d7c376bcefac360995f0d42ba6ba4b40a7e82f86656e5701'
const CONTRACT  = process.env.CONTRACT_ADDRESS  || '0x3466b6a7b2d9edbef7d55e86613cb2a510a3465d'

const sepoliaChain = {
  id: 11155111, name: 'Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
}

const account       = privateKeyToAccount(PRIV_KEY)
const publicClient  = createPublicClient({ chain: sepoliaChain, transport: http(RPC, { timeout: 20000 }) })
const walletClient  = createWalletClient({ account, chain: sepoliaChain, transport: http(RPC, { timeout: 40000 }) })

const SUPPLY_ABI = [{ name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]
const BALANCE_ABI = [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]

let pass = 0, fail = 0
function ok(label, detail = '')  { console.log(`  ✓  ${label}${detail ? `  (${detail})` : ''}`); pass++ }
function err(label, reason)      { console.error(`  ✗  ${label}\n     ${reason}`); fail++ }

console.log('\n=== Alpha Hub — Live E2E Mint Test (Sepolia) ===\n')
console.log(`  RPC:       ${RPC}`)
console.log(`  Wallet:    ${account.address}`)
console.log(`  Contract:  ${CONTRACT}\n`)

// ─── 1. Preflight ─────────────────────────────────────────────────────────────

console.log('--- 1. Preflight ---\n')

let blockNumber, walletBalance, supplyBefore
try {
  [blockNumber, walletBalance, supplyBefore] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: CONTRACT, abi: SUPPLY_ABI, functionName: 'totalSupply' }),
  ])
  ok(`RPC live`, `block ${blockNumber}`)
  ok(`Wallet balance`, `${(Number(walletBalance) / 1e18).toFixed(6)} ETH`)
  ok(`Contract live`, `totalSupply=${supplyBefore}`)
} catch (e) {
  err('Preflight', e.message.slice(0, 120))
  process.exit(1)
}

if (walletBalance === 0n) {
  console.error('\n  ✗ Wallet has no ETH. Fund 0x' + account.address + ' on Sepolia first.')
  process.exit(1)
}

// ─── 2. prepareMintTransaction ────────────────────────────────────────────────

console.log('\n--- 2. prepareMintTransaction ---\n')

let prepared
try {
  const t0 = Date.now()
  prepared = await prepareMintTransaction(
    { chain: 'sepolia', contractAddress: CONTRACT, walletAddress: account.address, mintPrice: '0', quantity: 1 },
    publicClient,
  )
  const ms = Date.now() - t0
  ok(`prepareMintTransaction`, `${ms}ms`)
  console.log(`       fn:      ${prepared.functionName}`)
  console.log(`       source:  ${prepared.source}`)
  console.log(`       gas:     ${prepared.gas}`)
  console.log(`       data:    ${prepared.data?.slice(0, 14)}…`)
} catch (e) {
  err('prepareMintTransaction', e.message.slice(0, 120))
  process.exit(1)
}

if (prepared.functionName !== 'mint') {
  err('functionName check', `expected "mint", got "${prepared.functionName}"`)
} else {
  ok(`functionName === "mint"`)
}

if (!prepared.data?.startsWith('0xa0712d68')) {
  err('selector check', `expected 0xa0712d68, got ${prepared.data?.slice(0, 10)}`)
} else {
  ok(`selector 0xa0712d68 (mint(uint256))`)
}

if (prepared.chainId !== 11155111) {
  err('chainId', `expected 11155111, got ${prepared.chainId}`)
} else {
  ok(`chainId === 11155111`)
}

// ─── 3. Submit & confirm ──────────────────────────────────────────────────────

console.log('\n--- 3. Submit TX ---\n')

let txHash, receipt
try {
  const t0 = Date.now()
  txHash = await walletClient.sendTransaction({
    to:    CONTRACT,
    data:  prepared.data,
    value: BigInt(prepared.value || '0'),
    gas:   BigInt(prepared.gas),
  })
  const submitMs = Date.now() - t0
  ok(`TX submitted`, `${submitMs}ms`)
  console.log(`       hash: ${txHash}`)
  console.log(`       https://sepolia.etherscan.io/tx/${txHash}`)
} catch (e) {
  err('sendTransaction', e.shortMessage || e.message.slice(0, 120))
  process.exit(1)
}

console.log('\n--- 4. Wait for confirmation ---\n')

try {
  const t0 = Date.now()
  process.stdout.write('  waiting')
  receipt = await Promise.race([
    publicClient.waitForTransactionReceipt({ hash: txHash }).then(r => { process.stdout.write('\n'); return r }),
    new Promise((_, reject) => {
      const tick = setInterval(() => process.stdout.write('.'), 2000)
      setTimeout(() => { clearInterval(tick); reject(new Error('90s timeout')) }, 90000)
    }),
  ])
  const confirmMs = Date.now() - t0
  if (receipt.status !== 'success') {
    err('Receipt status', `${receipt.status}`)
  } else {
    ok(`Confirmed on-chain`, `block ${receipt.blockNumber}, gas ${receipt.gasUsed}, ${confirmMs}ms`)
  }
} catch (e) {
  err('waitForTransactionReceipt', e.message.slice(0, 80))
  process.exit(1)
}

// ─── 5. Verify state ──────────────────────────────────────────────────────────

console.log('\n--- 5. Verify on-chain state ---\n')

try {
  const [supplyAfter, tokenBalance] = await Promise.all([
    publicClient.readContract({ address: CONTRACT, abi: SUPPLY_ABI, functionName: 'totalSupply' }),
    publicClient.readContract({ address: CONTRACT, abi: BALANCE_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])

  if (supplyAfter === supplyBefore + 1n) {
    ok(`totalSupply incremented`, `${supplyBefore} → ${supplyAfter}`)
  } else {
    err('totalSupply', `expected ${supplyBefore + 1n}, got ${supplyAfter}`)
  }

  if (tokenBalance >= 1n) {
    ok(`Wallet received NFT`, `balance=${tokenBalance}`)
  } else {
    err('balanceOf', `wallet balance is ${tokenBalance}`)
  }
} catch (e) {
  err('On-chain state check', e.message.slice(0, 80))
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`)
console.log(`Contract:  ${CONTRACT}`)
console.log(`TX hash:   ${txHash}`)
console.log(`Explorer:  https://sepolia.etherscan.io/tx/${txHash}`)
console.log(`Result:    ${pass}/${pass + fail} checks passed`)
console.log('─'.repeat(52) + '\n')

if (fail > 0) process.exitCode = 1
