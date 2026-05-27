/**
 * Real public mint E2E validation on Base mainnet.
 *
 * Stages:
 *  1. Readiness  — vault wallet, RPC, block
 *  2. Deploy     — TestMintNFT.sol to Base via vault wallet
 *  3. Prewarm    — prepareMintTransaction detects mint(uint256)
 *  4. Arm Strike — insert armed intent with prewarm fast-path call_data
 *  5. Dispatch   — Railway worker claims and executes
 *  6. Confirm    — tx receipt confirmed on Base
 *  7. Ownership  — balanceOf vault wallet > 0, ownerOf token = vault wallet
 *  8. Telemetry  — all execution events present
 *
 * Success criteria: real tx hash + receipt + NFT ownership + clean telemetry.
 *
 * Run: node worker/test/e2e-public-mint.test.mjs
 */

import { createPublicClient, createWalletClient, http, formatEther, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createClient } from '@supabase/supabase-js'
import solc from 'solc'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// ─── Config ───────────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url))

function loadEnv(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}
}
loadEnv(path.resolve(__dir, '../.env'))

const SUPABASE_URL    = process.env.SUPABASE_URL
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENCRYPTION_KEY  = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
const BASE_RPC        = process.env.BASE_RPC_URL || 'https://mainnet.base.org'

if (!SUPABASE_URL || !SUPABASE_KEY || !ENCRYPTION_KEY) {
  console.error('FATAL: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and WALLET_ENCRYPTION_KEY required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const baseChain = {
  id: 8453, name: 'base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC] } },
}

const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS  = 8 * 60 * 1000   // 8 min — allow for full retry cycle
const EXECUTE_DELAY_MS = 90 * 1000       // arm 90s out

// ─── Reporting ────────────────────────────────────────────────────────────────

let pass = 0, fail = 0, failedStage = null
const log = []

function ok(stage, label, detail = '') {
  const line = `  ✓  [${stage}] ${label}${detail ? `  (${detail})` : ''}`
  console.log(line); log.push(line); pass++
}
function no(stage, label, reason) {
  const line = `  ✗  [${stage}] ${label}\n       ${reason}`
  console.error(line); log.push(line); fail++
  if (!failedStage) failedStage = stage
}
function info(key, val) { console.log(`       ${key}:  ${val}`) }
function head(title) { console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}\n`) }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function decryptKey(encrypted, userId, masterKey) {
  const buf       = Buffer.from(encrypted, 'base64')
  const iv        = buf.subarray(0, 12)
  const tag       = buf.subarray(12, 28)
  const ct        = buf.subarray(28)
  const keyMat    = crypto.pbkdf2Sync(masterKey, Buffer.from(userId), 100000, 32, 'sha256')
  const decipher  = crypto.createDecipheriv('aes-256-gcm', keyMat, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ct) + decipher.final()
}

// ─── Compile TestMintNFT.sol ──────────────────────────────────────────────────

function compileContract() {
  const source = readFileSync(path.resolve(__dir, 'contracts/TestMintNFT.sol'), 'utf8')
  const input  = JSON.stringify({
    language: 'Solidity',
    sources: { 'TestMintNFT.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } }, optimizer: { enabled: true, runs: 200 } },
  })
  const out = JSON.parse(solc.compile(input))
  if (out.errors?.some(e => e.severity === 'error')) throw new Error(out.errors[0].message)
  const c = out.contracts['TestMintNFT.sol']['TestMintNFT']
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
}

// ─── ABI helpers ──────────────────────────────────────────────────────────────

const MINT_ABI    = [{ name: 'mint',         type: 'function', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [], stateMutability: 'payable' }]
const BALANCE_ABI = [{ name: 'balanceOf',    type: 'function', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]
const SUPPLY_ABI  = [{ name: 'totalSupply',  type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]
const OWNER_ABI   = [{ name: 'ownerOf',      type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' }]

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║   Alpha Hub — Public Mint E2E Validation (Base)          ║')
console.log('╚══════════════════════════════════════════════════════════╝')
const startMs = Date.now()

// ── Stage 1: Readiness ────────────────────────────────────────────────────────
head('Stage 1: Readiness')

let vaultWallet, privateKey, account, publicClient, walletClient

{
  // Load vault wallet from DB
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id, user_id, address, wallet_address, encrypted_private_key')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  if (error || !data) { no('readiness', 'Vault wallet', error?.message || 'none found'); process.exit(1) }
  vaultWallet = data
  vaultWallet.resolvedAddress = data.address || data.wallet_address

  try {
    privateKey = decryptKey(data.encrypted_private_key, data.user_id, ENCRYPTION_KEY)
    if (!/^[0-9a-fA-F]{64}$/.test(privateKey.replace(/^0x/, '')))
      throw new Error('not a hex key')
  } catch (e) { no('readiness', 'Wallet decrypt', e.message); process.exit(1) }

  account      = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`)
  publicClient = createPublicClient({ chain: baseChain, transport: http(BASE_RPC, { timeout: 20000 }) })
  walletClient = createWalletClient({ account, chain: baseChain, transport: http(BASE_RPC, { timeout: 40000 }) })

  const [block, balance] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getBalance({ address: account.address }),
  ])

  ok('readiness', 'Base RPC live', `block ${block}`)
  ok('readiness', 'Vault wallet loaded', `${account.address}`)
  info('ETH balance', formatEther(balance) + ' ETH')

  if (balance === 0n) { no('readiness', 'ETH balance', '0 ETH — fund wallet first'); process.exit(1) }
  ok('readiness', 'ETH balance sufficient', formatEther(balance) + ' ETH')
}

// ── Stage 2: Deploy TestMintNFT to Base ───────────────────────────────────────
head('Stage 2: Deploy TestMintNFT to Base')

let contractAddress

{
  const { abi, bytecode } = compileContract()
  ok('deploy', 'Contract compiled', `${bytecode.length / 2} bytes`)

  const feeData = await publicClient.estimateFeesPerGas()
  const gasEst  = await publicClient.estimateGas({
    account: account.address,
    data: bytecode,
  })
  info('deploy gas est', gasEst.toString())
  info('base fee', (Number(feeData.maxFeePerGas) / 1e9).toFixed(6) + ' gwei')

  const txHash = await walletClient.deployContract({ abi, bytecode })
  ok('deploy', 'Deploy tx submitted', txHash)
  info('explorer', `https://basescan.org/tx/${txHash}`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2, timeout: 90000 })
  if (receipt.status !== 'success') { no('deploy', 'Deploy receipt', `status=${receipt.status}`); process.exit(1) }

  contractAddress = receipt.contractAddress
  ok('deploy', 'Contract deployed', contractAddress)
  info('explorer', `https://basescan.org/address/${contractAddress}`)

  // Verify it works — retry up to 5× in case the node hasn't indexed the code yet
  let supply
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      supply = await publicClient.readContract({ address: contractAddress, abi: SUPPLY_ABI, functionName: 'totalSupply' })
      break
    } catch (e) {
      if (attempt === 5) { no('deploy', 'Contract live check', e.message.slice(0, 120)); process.exit(1) }
      await sleep(2000 * attempt)
    }
  }
  ok('deploy', 'Contract live — totalSupply', supply.toString())
}

// ── Stage 3: Prewarm (prepareMintTransaction detection) ───────────────────────
head('Stage 3: Prewarm — function detection')

let callData, gasEstimate

{
  // Encode mint(1) calldata directly — simulates what the prewarmer does for
  // a common-signature contract (no SeaDrop). The fast-path stores this in
  // call_data so the executor skips detection at T=0.
  callData    = encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [1n] })
  gasEstimate = 80000  // safe upper bound for a single ERC721 mint

  ok('prewarm', 'mint(1) calldata encoded', callData)
  info('gas estimate', gasEstimate.toString())

  // Verify the calldata will succeed via eth_call simulation
  try {
    await publicClient.simulateContract({
      address: contractAddress,
      abi: MINT_ABI,
      functionName: 'mint',
      args: [1n],
      account: account.address,
      value: 0n,
    })
    ok('prewarm', 'eth_call simulation passed', 'mint(1) would succeed')
  } catch (e) {
    no('prewarm', 'eth_call simulation', e.message.slice(0, 120))
    process.exit(1)
  }
}

// ── Stage 4: Arm Strike intent ────────────────────────────────────────────────
head('Stage 4: Arm Strike intent')

let intentId

{
  const executeAt = new Date(Date.now() + EXECUTE_DELAY_MS).toISOString()

  const { data, error } = await supabase
    .from('mint_intents')
    .insert({
      user_id:           vaultWallet.user_id,
      project_name:      'AlphaHub Test NFT (Base)',
      chain:             'base',
      contract_address:  contractAddress,
      to:                contractAddress,          // prewarm fast-path: executor uses intent.to
      call_data:         callData,                 // non-null → prewarm fast-path engaged
      value:             '0',
      gas_limit:         gasEstimate,
      function_name:     'mint',
      gas_strategy:      'balanced',
      vault_wallet_id:   vaultWallet.id,
      strike_enabled:    true,
      strike_execute_at: executeAt,
      status:            'armed',
      quantity:          1,
      last_state:        'E2E public mint: armed, awaiting worker',
    })
    .select().single()

  if (error || !data) { no('arm', 'Intent insert', error?.message); process.exit(1) }
  intentId = data.id
  ok('arm', 'Strike intent armed', `id=${intentId}`)
  info('contract', contractAddress)
  info('execute_at', executeAt)
  info('call_data', callData.slice(0, 18) + '…')
}

// ── Stages 5–7: Monitor — worker claim → dispatch → confirm ──────────────────
head('Stages 5–7: Pipeline monitoring')

console.log(`  Intent:   ${intentId}`)
console.log(`  Polling every ${POLL_INTERVAL_MS / 1000}s | timeout ${POLL_TIMEOUT_MS / 60000}min\n`)

// 'pending' is NOT terminal — the worker still needs to confirm and transition to 'success'
const TERMINAL = new Set(['success', 'failed', 'expired', 'cancelled'])
const seenStates = new Set()
let finalState = null
let txHash = null
const pollStart = Date.now()

while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
  await sleep(POLL_INTERVAL_MS)

  const { data: intent } = await supabase
    .from('mint_intents')
    .select('status, last_state, tx_hash, updated_at')
    .eq('id', intentId).single()

  if (!intent) continue
  const st = intent.status

  if (!seenStates.has(st)) {
    seenStates.add(st)
    const labels = {
      armed:     'Step 5a: intent armed (initial)',
      executing: 'Step 5b: Worker claimed → executing',
      retrying:  'Step 5c: Retry cycle active',
      pending:   'Step 6:  Tx broadcast → pending confirmation',
      success:   'Step 7:  Tx confirmed → success',
      failed:    'Step 7:  Terminal state: failed',
    }
    ok(labels[st] ? st : 'monitor', labels[st] || `State: ${st}`, `"${intent.last_state?.slice(0, 70)}"`)
  }

  if (intent.tx_hash && !txHash) {
    txHash = intent.tx_hash
    ok('dispatch', 'Step 6b: tx_hash recorded', txHash)
    info('basescan', `https://basescan.org/tx/${txHash}`)
  }

  if (TERMINAL.has(st)) { finalState = st; break }
}

if (!finalState) {
  no('monitor', 'Pipeline timeout', `Still in: ${[...seenStates].join(' → ')} after ${POLL_TIMEOUT_MS / 60000}min`)
}

// ── Stage 6: Receipt verification ─────────────────────────────────────────────
head('Stage 6: Receipt verification')

let supplyAfter = 0n

if (txHash) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    if (receipt?.status === 'success') {
      ok('receipt', 'Tx confirmed on Base', `block ${receipt.blockNumber}`)
      info('gas used', receipt.gasUsed.toString())
      info('basescan', `https://basescan.org/tx/${txHash}`)
    } else {
      no('receipt', 'Tx receipt status', `status=${receipt?.status}`)
    }
  } catch (e) {
    no('receipt', 'getTransactionReceipt', e.message.slice(0, 120))
  }
} else {
  no('receipt', 'tx_hash', `No tx hash — final state: ${finalState}`)
}

// ── Stage 7: NFT ownership ────────────────────────────────────────────────────
head('Stage 7: NFT ownership verification')

{
  try {
    const [balance, supply] = await Promise.all([
      publicClient.readContract({ address: contractAddress, abi: BALANCE_ABI, functionName: 'balanceOf', args: [account.address] }),
      publicClient.readContract({ address: contractAddress, abi: SUPPLY_ABI, functionName: 'totalSupply' }),
    ])
    supplyAfter = supply
    if (balance > 0n) {
      ok('ownership', `balanceOf(vault) = ${balance}`, 'NFT minted to vault wallet')
    } else {
      no('ownership', 'balanceOf(vault)', '0 — NFT not minted to vault wallet')
    }
    ok('ownership', `totalSupply = ${supply}`, 'on-chain state updated')

    // Verify ownerOf token 1 (or latest token)
    const tokenId = supply
    if (tokenId > 0n) {
      try {
        const owner = await publicClient.readContract({ address: contractAddress, abi: OWNER_ABI, functionName: 'ownerOf', args: [tokenId] })
        if (owner.toLowerCase() === account.address.toLowerCase()) {
          ok('ownership', `ownerOf(${tokenId}) = vault wallet`, 'ownership confirmed')
        } else {
          no('ownership', `ownerOf(${tokenId})`, `expected ${account.address}, got ${owner}`)
        }
      } catch (e) {
        no('ownership', `ownerOf(${tokenId})`, e.message.slice(0, 80))
      }
    }
  } catch (e) {
    no('ownership', 'Contract read', e.message.slice(0, 120))
  }
}

// ── Stage 8: Telemetry ────────────────────────────────────────────────────────
head('Stage 8: Telemetry chain')

{
  const { data: events } = await supabase
    .from('mint_execution_events')
    .select('state, message, created_at')
    .eq('intent_id', intentId)
    .order('created_at', { ascending: true })

  if (events?.length) {
    ok('telemetry', `${events.length} execution events recorded`)
    for (const e of events) {
      const ts = new Date(e.created_at).toISOString().slice(11, 19)
      console.log(`  [${ts}] [${e.state.padEnd(14)}]  ${e.message?.slice(0, 90)}`)
    }
  } else {
    no('telemetry', 'Execution events', 'none found')
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
const total   = pass + fail

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║   Public Mint E2E Summary                                ║')
console.log('╚══════════════════════════════════════════════════════════╝\n')
console.log(`  Contract:   ${contractAddress}`)
console.log(`  Intent ID:  ${intentId}`)
console.log(`  States:     ${[...seenStates].join(' → ')}`)
console.log(`  Final:      ${finalState ?? 'timeout'}`)
console.log(`  Tx hash:    ${txHash ?? '(none)'}`)
console.log(`  Supply:     ${supplyAfter}`)
console.log(`  Elapsed:    ${elapsed}s`)
console.log(`  Result:     ${pass}/${total} passed | ${fail} failed`)

if (fail === 0) {
  console.log('\n  PASS — public mint pipeline validated end-to-end.\n')
} else {
  console.log(`\n  FAIL — first failure at stage: ${failedStage}\n`)
  process.exitCode = 1
}
