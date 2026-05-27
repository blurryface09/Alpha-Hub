#!/usr/bin/env node
/**
 * UAT scenario setup — AlphaHubValidationNFT
 *
 * Usage:
 *   node scripts/setup-uat-scenario.mjs c          # Scenario C: set startTime +120s
 *   node scripts/setup-uat-scenario.mjs c-reset     # Reset startTime to 0
 *   node scripts/setup-uat-scenario.mjs d           # Scenario D: set maxSupply to minted+2
 *   node scripts/setup-uat-scenario.mjs d-reset     # Reset maxSupply to 0
 *   node scripts/setup-uat-scenario.mjs b           # Scenario B: set mintPrice 0.00001 ETH
 *   node scripts/setup-uat-scenario.mjs b-reset     # Reset mintPrice to 0
 *   node scripts/setup-uat-scenario.mjs status      # Print current contract state
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const root  = path.resolve(__dir, '..')

function loadEnv(p) {
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}
}
loadEnv(path.resolve(root, 'worker/.env'))
loadEnv(path.resolve(root, '.env'))
loadEnv(path.resolve(root, '.env.local'))

const CONTRACT = '0x1ee151e31999bd8441f6c1ab221f66cd2c8bbde7'
const ABI = parseAbi([
  'function mintConfig() view returns (bool active, uint256 price, uint256 start, uint256 end, uint256 supply, uint256 minted, uint256 perWallet, uint256 perTx)',
  'function setStartTime(uint256 ts) external',
  'function setEndTime(uint256 ts) external',
  'function setMaxSupply(uint256 supply) external',
  'function setMintPrice(uint256 price) external',
  'function setMintActive(bool active) external',
])

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const viemChain = {
  id: 8453, name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
}
const publicClient = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 30000 }) })

async function loadWallet() {
  if (process.env.DEPLOY_PRIVATE_KEY) {
    const pk = process.env.DEPLOY_PRIVATE_KEY.startsWith('0x')
      ? process.env.DEPLOY_PRIVATE_KEY : `0x${process.env.DEPLOY_PRIVATE_KEY}`
    return privateKeyToAccount(pk)
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const { data } = await supabase
    .from('alpha_vault_wallets')
    .select('id, user_id, address, wallet_address, encrypted_private_key')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  if (!data) throw new Error('No vault wallet in DB')
  const encKey = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  const buf = Buffer.from(data.encrypted_private_key, 'base64')
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28)
  const keyMat = crypto.pbkdf2Sync(encKey, Buffer.from(data.user_id), 100000, 32, 'sha256')
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyMat, iv)
  decipher.setAuthTag(tag)
  const pk = (decipher.update(ct) + decipher.final()).trim()
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
}

async function getConfig() {
  const cfg = await publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: 'mintConfig' })
  return { active: cfg[0], price: cfg[1], start: cfg[2], end: cfg[3], maxSupply: cfg[4], minted: cfg[5] }
}

async function send(account, functionName, args) {
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(RPC, { timeout: 60000 }) })
  const hash = await walletClient.writeContract({ address: CONTRACT, abi: ABI, functionName, args })
  process.stdout.write(`  tx ${hash.slice(0, 20)}... `)
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60000 })
  console.log('✓')
  return hash
}

const scenario = process.argv[2]
if (!scenario) {
  console.log('Usage: node scripts/setup-uat-scenario.mjs <c|c-reset|d|d-reset|b|b-reset|status>')
  process.exit(1)
}

const cfg = await getConfig()
console.log('\n  Contract:', CONTRACT)
console.log('  mintActive:', cfg.active, '| mintPrice:', cfg.price.toString(), '| minted:', cfg.minted.toString(), '| maxSupply:', cfg.maxSupply.toString())
console.log('  startTime:', cfg.start.toString(), '| endTime:', cfg.end.toString())

if (scenario === 'status') process.exit(0)

const account = await loadWallet()
console.log('  Wallet:', account.address, '\n')

if (scenario === 'c') {
  const startTime = BigInt(Math.floor(Date.now() / 1000) + 120)
  console.log('  Setting startTime =', startTime.toString(), '(now + 120s)')
  console.log('  Start opens at:', new Date(Number(startTime) * 1000).toLocaleTimeString())
  await send(account, 'setStartTime', [startTime])
  console.log('\n  ✅ Scenario C ready.')
  console.log('  → Arm Strike NOW → it should fail with "not started"')
  console.log('  → Arm Strike at', new Date(Number(startTime) * 1000).toLocaleTimeString(), '→ should succeed')
  console.log('  → Run   node scripts/setup-uat-scenario.mjs c-reset   when done')
}

else if (scenario === 'c-reset') {
  console.log('  Resetting startTime to 0')
  await send(account, 'setStartTime', [0n])
  console.log('\n  ✅ startTime cleared.')
}

else if (scenario === 'd') {
  const newMax = cfg.minted + 2n
  console.log(`  Setting maxSupply = ${newMax} (minted=${cfg.minted}, gives 2 more mints)`)
  await send(account, 'setMaxSupply', [newMax])
  console.log('\n  ✅ Scenario D ready.')
  console.log('  → Arm Strike → succeeds (total =', (cfg.minted + 1n).toString() + ')')
  console.log('  → Arm Strike → succeeds (total =', (cfg.minted + 2n).toString() + ', supply full)')
  console.log('  → Arm Strike → should FAIL with "supply exhausted"')
  console.log('  → Run   node scripts/setup-uat-scenario.mjs d-reset   when done')
}

else if (scenario === 'd-reset') {
  console.log('  Resetting maxSupply to 0 (unlimited)')
  await send(account, 'setMaxSupply', [0n])
  console.log('\n  ✅ maxSupply cleared.')
}

else if (scenario === 'b') {
  const price = parseEther('0.00001')  // 0.00001 ETH — cheap enough for vault wallet
  console.log('  Setting mintPrice =', price.toString(), 'wei (0.00001 ETH)')
  await send(account, 'setMintPrice', [price])
  console.log('\n  ✅ Scenario B ready.')
  console.log('  → Arm Strike → should detect paid mint and include correct ETH value')
  console.log('  → Check vault has enough ETH (needs 0.00001 ETH per mint)')
  console.log('  → Run   node scripts/setup-uat-scenario.mjs b-reset   when done')
}

else if (scenario === 'b-reset') {
  console.log('  Resetting mintPrice to 0')
  await send(account, 'setMintPrice', [0n])
  console.log('\n  ✅ mintPrice cleared.')
}

else {
  console.error('  Unknown scenario:', scenario)
  process.exit(1)
}
