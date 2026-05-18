/**
 * Wallet execution model.
 * Handles decryption of vault wallets and construction of viem WalletClients.
 * Multi-wallet and burner wallet modes are behind feature flags (future use).
 */

import crypto from 'crypto'
import { createWalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { FLAGS } from './flags.js'
import { createLogger } from './logger.js'

const log = createLogger(null, null)

// ─── Chain definitions ────────────────────────────────────────────────────────

const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  bnb: 56,
  apechain: 33139,
}

const CHAIN_NAMES = {
  eth: 'Ethereum',
  base: 'Base',
  bnb: 'BNB Smart Chain',
  apechain: 'ApeChain',
}

function normaliseChain(chain = 'eth') {
  const text = String(chain || '').toLowerCase()
  if (text.includes('base')) return 'base'
  if (text.includes('ape')) return 'apechain'
  if (text.includes('bnb') || text.includes('bsc')) return 'bnb'
  return 'eth'
}

/**
 * Build a viem chain descriptor.
 * @param {string} chainKey
 */
function buildChainDescriptor(chainKey) {
  const id = CHAIN_IDS[chainKey] ?? 1
  return {
    id,
    name: CHAIN_NAMES[chainKey] ?? 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } }, // transport is injected externally
  }
}

// ─── Decryption ───────────────────────────────────────────────────────────────

/**
 * Decrypt an AES-256-GCM encrypted private key.
 * Matches the encryption format used by the vault-engine.
 *
 * @param {string} encrypted  — base64 encoded (iv[12] + tag[16] + ciphertext)
 * @param {string} userId     — used as PBKDF2 salt
 * @returns {string}          — hex private key (with or without 0x prefix)
 */
export function decryptPrivateKey(encrypted, userId) {
  const secret = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  if (!secret) throw new Error('ALPHA_VAULT_ENCRYPTION_KEY is not configured')
  const key = crypto.pbkdf2Sync(secret, userId, 100_000, 32, 'sha256')
  const packed = Buffer.from(encrypted, 'base64')
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const data = packed.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// ─── Wallet client factory ────────────────────────────────────────────────────

/**
 * Build a viem WalletClient from an account descriptor.
 *
 * @param {import('viem').Account} account
 * @param {string} chainKey
 * @param {import('viem').Transport} transport
 * @returns {import('viem').WalletClient}
 */
export function buildWalletClient(account, chainKey, transport) {
  return createWalletClient({
    account,
    chain: buildChainDescriptor(normaliseChain(chainKey)),
    transport,
  })
}

// ─── Vault loading ────────────────────────────────────────────────────────────

/**
 * Load the best vault wallet row for a given intent.
 * Prefers intent.vault_wallet_id if set, otherwise falls back to the most
 * recently created active wallet for the user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id: string, user_id: string, vault_wallet_id?: string }} intent
 * @returns {Promise<object|null>}
 */
async function loadVaultRow(supabase, intent) {
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

  // Fallback: most-recently-created active wallet for user
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id,address,wallet_address,encrypted_private_key,status')
    .eq('user_id', intent.user_id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Load all active vault wallets for a user (multi-wallet mode).
 * Round-robin selection: picks the wallet with the oldest last_used_at.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function loadLeastRecentlyUsedWallet(supabase, userId) {
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id,address,wallet_address,encrypted_private_key,status,last_used_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Load an execution wallet for the given intent.
 * Returns a wallet descriptor with a ready-to-use WalletClient.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id: string, user_id: string, vault_wallet_id?: string, chain?: string }} intent
 * @param {import('./flags.js').FLAGS} flags
 * @param {import('viem').Transport} transport  — injected transport (from rpc.js)
 * @returns {Promise<{
 *   address: string,
 *   account: import('viem').Account,
 *   walletClient: import('viem').WalletClient,
 *   walletId: string,
 *   source: 'vault'|'burner',
 * }>}
 */
export async function loadExecutionWallet(supabase, intent, flags, transport) {
  const intentLog = createLogger(intent.id, intent.user_id)
  const chainKey = normaliseChain(intent.chain)

  // ── Multi-wallet path (future) ──────────────────────────────────────────
  let vaultRow
  if (flags.MULTI_WALLET_ENABLED) {
    intentLog.debug('prepare', 'Multi-wallet mode: selecting LRU wallet')
    vaultRow = await loadLeastRecentlyUsedWallet(supabase, intent.user_id)
  } else {
    vaultRow = await loadVaultRow(supabase, intent)
  }

  if (!vaultRow?.encrypted_private_key) {
    throw new Error('Alpha Vault wallet not found or not active for this intent.')
  }

  intentLog.debug('prepare', 'Decrypting vault wallet', { wallet_id: vaultRow.id })
  const privateKeyRaw = decryptPrivateKey(vaultRow.encrypted_private_key, intent.user_id)
  const privateKey = privateKeyRaw.startsWith('0x')
    ? privateKeyRaw
    : `0x${privateKeyRaw}`

  const account = privateKeyToAccount(privateKey)
  const walletClient = buildWalletClient(account, chainKey, transport)

  const address = vaultRow.address || vaultRow.wallet_address || account.address

  intentLog.info('prepare', 'Execution wallet loaded', {
    wallet_id: vaultRow.id,
    address,
    chain: chainKey,
    source: 'vault',
  })

  return {
    address,
    account,
    walletClient,
    walletId: vaultRow.id,
    source: 'vault',
  }
}
