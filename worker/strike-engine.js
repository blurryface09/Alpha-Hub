import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { prepareMintTransaction } from '../api/_lib/mint-engine.js'

const LOOP_MS = Number(process.env.STRIKE_WORKER_INTERVAL_MS || 15000)
const BATCH_SIZE = Number(process.env.STRIKE_WORKER_BATCH_SIZE || 3)
const RUN_ONCE = String(process.env.STRIKE_WORKER_RUN_ONCE || '').toLowerCase() === 'true'
const AUTO_STRIKE_ENABLED = String(process.env.AUTO_STRIKE_ENABLED || '').toLowerCase() === 'true'
const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'

const CHAIN_RPC = {
  eth: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  apechain: process.env.APECHAIN_RPC_URL || '',
}

const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  apechain: 33139,
}

let stopping = false

function log(...args) {
  console.log(new Date().toISOString(), '[strike-worker]', ...args)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envReady() {
  const missing = []
  if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!process.env.ALPHA_VAULT_ENCRYPTION_KEY && !process.env.WALLET_ENCRYPTION_KEY) missing.push('ALPHA_VAULT_ENCRYPTION_KEY')
  return missing
}

function supabaseClient() {
  return createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

function normalizeChain(chain = 'eth') {
  const text = String(chain || '').toLowerCase()
  if (text.includes('base')) return 'base'
  if (text.includes('ape')) return 'apechain'
  return 'eth'
}

function chainObject(chain) {
  const id = CHAIN_IDS[chain] || 1
  return {
    id,
    name: chain === 'base' ? 'Base' : chain === 'apechain' ? 'ApeChain' : 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CHAIN_RPC[chain]].filter(Boolean) } },
  }
}

function decryptPrivateKey(encrypted, userId) {
  const secret = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  const key = crypto.pbkdf2Sync(secret, userId, 100000, 32, 'sha256')
  const packed = Buffer.from(encrypted, 'base64')
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const data = packed.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

async function insertEvent(supabase, intent, state, message, metadata = {}) {
  await supabase.from('mint_execution_events').insert({
    intent_id: intent.id,
    user_id: intent.user_id,
    state,
    message,
    metadata,
  }).throwOnError()
}

async function recordAttempt(supabase, intent, status, patch = {}) {
  await supabase.from('mint_attempts').insert({
    intent_id: intent.id,
    mint_intent_id: intent.id,
    user_id: intent.user_id,
    status,
    ...patch,
  }).throwOnError()
}

async function loadVault(supabase, userId) {
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id,address,wallet_address,encrypted_private_key,status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] || null
}

async function loadIntentVault(supabase, intent) {
  if (intent.vault_wallet_id) {
    const { data, error } = await supabase
      .from('alpha_vault_wallets')
      .select('id,address,wallet_address,encrypted_private_key,status')
      .eq('id', intent.vault_wallet_id)
      .eq('user_id', intent.user_id)
      .eq('status', 'active')
      .maybeSingle()
    if (!error && data) return data
  }
  return loadVault(supabase, intent.user_id)
}

async function claimIntent(supabase, intent) {
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status: 'executing',
      last_state: 'Preparing Strike transaction',
      updated_at: new Date().toISOString(),
    })
    .eq('id', intent.id)
    .eq('strike_enabled', true)
    .in('status', ['armed', 'watching', 'prepared'])
    .select()
    .single()
  if (error || !data) return null
  return data
}

async function processIntent(supabase, queuedIntent) {
  const intent = await claimIntent(supabase, queuedIntent)
  if (!intent) return

  try {
    await insertEvent(supabase, intent, 'preparing', 'Strike worker is preparing the mint.')
    const vault = await loadIntentVault(supabase, intent)
    if (!vault?.encrypted_private_key) throw new Error('Alpha Vault is not ready.')

    const privateKey = decryptPrivateKey(vault.encrypted_private_key, intent.user_id)
    const account = privateKeyToAccount(privateKey)
    const chain = normalizeChain(intent.chain)
    const rpc = CHAIN_RPC[chain]
    if (!rpc) throw new Error('Strike RPC is not configured for this chain.')

    const prepared = await prepareMintTransaction({
      ...intent,
      walletAddress: account.address,
      mintPrice: intent.max_mint_price || '0',
      maxTotalSpend: intent.max_total_spend,
    })
    await insertEvent(supabase, intent, 'simulating', 'Mint simulation passed. Broadcasting Strike transaction.', {
      functionName: prepared.functionName,
      chainId: prepared.chainId,
    })

    const walletClient = createWalletClient({
      account,
      chain: chainObject(chain),
      transport: http(rpc, { timeout: 10000 }),
    })

    const txHash = await walletClient.sendTransaction({
      to: prepared.to,
      data: prepared.data,
      value: BigInt(prepared.value || '0'),
      gas: prepared.gas ? BigInt(prepared.gas) : undefined,
    })

    await recordAttempt(supabase, intent, 'submitted', { tx_hash: txHash })
    await supabase.from('mint_intents').update({
      status: 'submitted',
      tx_hash: txHash,
      last_state: 'Strike transaction submitted',
      updated_at: new Date().toISOString(),
    }).eq('id', intent.id).throwOnError()
    await insertEvent(supabase, intent, 'submitted', 'Strike transaction submitted.', { txHash })
    log('submitted', intent.id, txHash)
  } catch (error) {
    const message = String(error?.shortMessage || error?.message || 'Strike execution failed.').slice(0, 240)
    await recordAttempt(supabase, intent, 'failed', { error_message: message }).catch(() => null)
    await supabase.from('mint_intents').update({
      status: 'failed',
      strike_enabled: false,
      simulation_status: 'failed',
      simulation_error: message,
      last_state: 'Strike failed safely',
      updated_at: new Date().toISOString(),
    }).eq('id', intent.id).catch(() => null)
    await insertEvent(supabase, intent, 'failed', 'Strike failed safely. No duplicate transaction will be sent.', { error: message }).catch(() => null)
    log('failed', intent.id, message)
  }
}

async function tick(supabase) {
  if (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED) {
    log('disabled by safety switches')
    return
  }

  const { data, error } = await supabase
    .from('mint_intents')
    .select('*')
    .eq('strike_enabled', true)
    .in('status', ['armed', 'watching', 'prepared'])
    .order('updated_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) throw error
  const now = Date.now()
  const ready = (data || []).filter(intent => {
    if (!intent.strike_execute_at) return true
    const executeAt = new Date(intent.strike_execute_at).getTime()
    return Number.isNaN(executeAt) || executeAt <= now
  })
  for (const intent of ready) {
    await processIntent(supabase, intent)
  }
  if (!data?.length) log('idle')
  else if (!ready.length) log('armed intents waiting for mint time', data.length)
}

async function main() {
  const missing = envReady()
  if (missing.length) {
    log(`missing env: ${missing.join(', ')}. Worker booted safely but will not execute.`)
    if (RUN_ONCE) return
  }

  const supabase = missing.length ? null : supabaseClient()
  log('started', { autoStrike: AUTO_STRIKE_ENABLED, alphaVault: ALPHA_VAULT_ENABLED, intervalMs: LOOP_MS })

  while (!stopping) {
    try {
      if (supabase) await tick(supabase)
    } catch (error) {
      log('tick error', String(error?.message || error))
    }
    if (RUN_ONCE) break
    await sleep(LOOP_MS)
  }

  log('stopped')
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
