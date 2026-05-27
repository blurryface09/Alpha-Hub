#!/usr/bin/env node
/**
 * Deploy AlphaHubValidationNFT to Base Sepolia or Base mainnet.
 *
 * Usage:
 *   node scripts/deploy-validation-nft.mjs                    # → Base Sepolia (default)
 *   node scripts/deploy-validation-nft.mjs --network mainnet  # → Base mainnet
 *   node scripts/deploy-validation-nft.mjs --active           # activate mint after deploy
 *   node scripts/deploy-validation-nft.mjs --price 0.001      # set mint price (ETH)
 *   node scripts/deploy-validation-nft.mjs --supply 1000      # set max supply
 *
 * Wallet:
 *   Uses DEPLOY_PRIVATE_KEY env var if set, otherwise loads vault wallet from DB.
 *
 * Writes deployment record to:
 *   contracts/deployments/<network>-<timestamp>.json
 *   contracts/deployments/latest-<network>.json  (overwritten each run)
 */

import { createPublicClient, createWalletClient, http, formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createClient } from '@supabase/supabase-js'
import { createRequire } from 'module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import crypto from 'crypto'

const require = createRequire(import.meta.url)
const solc = require('solc')

const __dir = path.dirname(fileURLToPath(import.meta.url))
const root  = path.resolve(__dir, '..')

// ─── Env ─────────────────────────────────────────────────────────────────────

function loadEnv(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}
}
loadEnv(path.resolve(root, 'worker/.env'))
loadEnv(path.resolve(root, '.env'))
loadEnv(path.resolve(root, '.env.local'))

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const network    = args.includes('--network') ? args[args.indexOf('--network') + 1] : 'sepolia'
const activateNow = args.includes('--active')
const priceEth   = args.includes('--price') ? parseFloat(args[args.indexOf('--price') + 1]) : 0
const maxSupply  = args.includes('--supply') ? parseInt(args[args.indexOf('--supply') + 1]) : 0
const startDelay = args.includes('--delay') ? parseInt(args[args.indexOf('--delay') + 1]) : 0  // seconds

const MAINNET = network === 'mainnet'

// ─── Chain config ─────────────────────────────────────────────────────────────

const CHAINS = {
  sepolia: {
    id: 84532,
    name: 'Base Sepolia',
    key: 'base-sepolia',
    rpcEnv: 'BASE_SEPOLIA_RPC_URL',
    fallback: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
  },
  mainnet: {
    id: 8453,
    name: 'Base',
    key: 'base',
    rpcEnv: 'BASE_RPC_URL',
    fallback: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
  },
}

const chain = CHAINS[MAINNET ? 'mainnet' : 'sepolia']
const rpcUrl = process.env[chain.rpcEnv] || chain.fallback

// ─── Compile ──────────────────────────────────────────────────────────────────

function compile() {
  const source = readFileSync(path.resolve(root, 'contracts/AlphaHubValidationNFT.sol'), 'utf8')
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { 'AlphaHubValidationNFT.sol': { content: source } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } },
      optimizer: { enabled: true, runs: 200 },
    },
  })
  const out = JSON.parse(solc.compile(input))
  const errors = out.errors?.filter(e => e.severity === 'error') ?? []
  if (errors.length) throw new Error(`Compile error: ${errors[0].formattedMessage}`)
  const warnings = out.errors?.filter(e => e.severity === 'warning') ?? []
  if (warnings.length) console.warn(`  ⚠  ${warnings.length} compile warning(s)`)
  const contract = out.contracts['AlphaHubValidationNFT.sol']['AlphaHubValidationNFT']
  return {
    abi: contract.abi,
    bytecode: '0x' + contract.evm.bytecode.object,
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function loadWallet() {
  if (process.env.DEPLOY_PRIVATE_KEY) {
    const pk = process.env.DEPLOY_PRIVATE_KEY.startsWith('0x')
      ? process.env.DEPLOY_PRIVATE_KEY
      : `0x${process.env.DEPLOY_PRIVATE_KEY}`
    return { account: privateKeyToAccount(pk), source: 'DEPLOY_PRIVATE_KEY' }
  }

  // Load from Supabase vault wallet
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id, user_id, address, wallet_address, encrypted_private_key')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  if (error || !data) throw new Error('No vault wallet found in DB: ' + (error?.message || 'none'))

  const encKey  = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  const buf     = Buffer.from(data.encrypted_private_key, 'base64')
  const iv      = buf.subarray(0, 12)
  const tag     = buf.subarray(12, 28)
  const ct      = buf.subarray(28)
  const keyMat  = crypto.pbkdf2Sync(encKey, Buffer.from(data.user_id), 100000, 32, 'sha256')
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyMat, iv)
  decipher.setAuthTag(tag)
  const pk = (decipher.update(ct) + decipher.final()).trim()
  const pkFull = pk.startsWith('0x') ? pk : `0x${pk}`

  return { account: privateKeyToAccount(pkFull), source: 'vault_wallet', walletId: data.id }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║   AlphaHubValidationNFT — Deployment Script              ║')
console.log('╚══════════════════════════════════════════════════════════╝\n')
console.log(`  Network:     ${chain.name} (${chain.id})`)
console.log(`  RPC:         ${rpcUrl.slice(0, 50)}...`)
console.log(`  Mint price:  ${priceEth} ETH`)
console.log(`  Max supply:  ${maxSupply === 0 ? 'unlimited' : maxSupply}`)
console.log(`  Activate:    ${activateNow}`)
console.log(`  Start delay: ${startDelay}s\n`)

if (MAINNET) {
  console.log('  ⚠  MAINNET deployment — this costs real ETH.')
  console.log('     Ctrl-C within 5 seconds to abort...\n')
  await new Promise(r => setTimeout(r, 5000))
}

// Compile
process.stdout.write('  Compiling contract... ')
const { abi, bytecode } = compile()
console.log(`✓  (${Math.round(bytecode.length / 2)} bytes)`)

// Load wallet
process.stdout.write('  Loading wallet... ')
const { account, source, walletId } = await loadWallet()
console.log(`✓  ${account.address}  (${source})`)

// Viem clients
const viemChain = {
  id: chain.id,
  name: chain.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
}
const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl, { timeout: 30000 }) })
const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl, { timeout: 60000 }) })

// Check balance
const balance = await publicClient.getBalance({ address: account.address })
const block   = await publicClient.getBlockNumber()
console.log(`  ETH balance: ${formatEther(balance)} ETH`)
console.log(`  Block:       ${block}`)

if (balance === 0n) {
  console.error('\n  ✗ Wallet has no ETH — fund it first.')
  process.exit(1)
}

// Constructor args
const mintPriceWei = priceEth > 0 ? parseEther(priceEth.toString()) : 0n
const startTimestamp = startDelay > 0 ? BigInt(Math.floor(Date.now() / 1000) + startDelay) : 0n

// Estimate gas
process.stdout.write('  Estimating deployment gas... ')
const gasEst = await publicClient.estimateGas({
  account: account.address,
  data: bytecode,
})
const feeData = await publicClient.estimateFeesPerGas()
const estCostEth = formatEther(gasEst * feeData.maxFeePerGas)
console.log(`✓  ~${gasEst} gas  (~${parseFloat(estCostEth).toFixed(8)} ETH)`)

// Deploy
console.log('\n  Deploying...')
const deployHash = await walletClient.deployContract({
  abi,
  bytecode,
  args: [
    'AlphaHub Validation NFT',
    'AHVAL',
    mintPriceWei,
    BigInt(maxSupply),
    startTimestamp,
  ],
})
console.log(`  ✓ Deploy tx submitted: ${deployHash}`)
console.log(`    ${chain.explorer}/tx/${deployHash}`)

// Wait for receipt
process.stdout.write('  Waiting for confirmation (2 blocks)... ')
const receipt = await publicClient.waitForTransactionReceipt({
  hash: deployHash,
  confirmations: 2,
  timeout: 120000,
})
if (receipt.status !== 'success') {
  console.error(`\n  ✗ Deploy failed (status=${receipt.status})`)
  process.exit(1)
}
const contractAddress = receipt.contractAddress
console.log(`✓  block ${receipt.blockNumber}`)
console.log(`\n  ✅ Contract deployed: ${contractAddress}`)
console.log(`     ${chain.explorer}/address/${contractAddress}`)

// Activate if requested
if (activateNow) {
  process.stdout.write('\n  Activating mint... ')
  const activateHash = await walletClient.writeContract({
    address: contractAddress,
    abi,
    functionName: 'setMintActive',
    args: [true],
  })
  await publicClient.waitForTransactionReceipt({ hash: activateHash, confirmations: 1, timeout: 60000 })
  console.log(`✓  ${activateHash}`)
}

// Save deployment artifact
const deployment = {
  contract:    'AlphaHubValidationNFT',
  network:     chain.key,
  chainId:     chain.id,
  address:     contractAddress,
  deployer:    account.address,
  deployTx:    deployHash,
  block:       receipt.blockNumber.toString(),
  gasUsed:     receipt.gasUsed.toString(),
  mintPrice:   mintPriceWei.toString(),
  maxSupply:   maxSupply,
  startTime:   startTimestamp.toString(),
  mintActive:  activateNow,
  deployedAt:  new Date().toISOString(),
  explorer:    `${chain.explorer}/address/${contractAddress}`,
  abi,
}

const deploymentsDir = path.resolve(root, 'contracts/deployments')
if (!existsSync(deploymentsDir)) mkdirSync(deploymentsDir, { recursive: true })

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const filename     = `${chain.key}-${ts}.json`
const latestFile   = `latest-${chain.key}.json`

writeFileSync(path.join(deploymentsDir, filename), JSON.stringify(deployment, null, 2))
writeFileSync(path.join(deploymentsDir, latestFile), JSON.stringify(deployment, null, 2))

console.log(`\n  Deployment saved:`)
console.log(`    contracts/deployments/${filename}`)
console.log(`    contracts/deployments/${latestFile}`)

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║   Deployment complete                                    ║')
console.log('╚══════════════════════════════════════════════════════════╝\n')
console.log(`  Contract:  ${contractAddress}`)
console.log(`  Network:   ${chain.name}`)
console.log(`  Block:     ${receipt.blockNumber}`)
console.log(`  Gas used:  ${receipt.gasUsed.toLocaleString()}`)
console.log(`  Explorer:  ${chain.explorer}/address/${contractAddress}`)
console.log('\n  Next steps:')
if (!activateNow) {
  console.log(`  1. Activate mint:`)
  console.log(`       node scripts/verify-validation-nft.mjs --network ${MAINNET ? 'mainnet' : 'sepolia'} --activate`)
}
console.log(`  ${activateNow ? '1' : '2'}. Run verification:`)
console.log(`       node scripts/verify-validation-nft.mjs --network ${MAINNET ? 'mainnet' : 'sepolia'}`)
console.log()
