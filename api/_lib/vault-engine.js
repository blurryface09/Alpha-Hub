import crypto from 'crypto'
import { createPublicClient, formatEther, http, isAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createServiceClient, requireUser } from './auth.js'
import { rateLimit, sendRateLimit } from './redis.js'

const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'
const RPCS = {
  eth: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
}

function safeError(error = 'Alpha Vault is temporarily unavailable.') {
  return { ok: false, error }
}

function encryptionKey(userId) {
  const secret = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  if (!secret) throw new Error('Vault encryption is not configured')
  return crypto.pbkdf2Sync(secret, userId, 100_000, 32, 'sha256')
}

function encryptPrivateKey(privateKey, userId) {
  const key = encryptionKey(userId)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

function clientFor(chain) {
  const url = RPCS[chain]
  if (!url) return null
  const id = chain === 'base' ? 8453 : 1
  return createPublicClient({
    chain: {
      id,
      name: chain === 'base' ? 'Base' : 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    },
    transport: http(url, { timeout: 7000 }),
  })
}

async function balanceFor(address, chain) {
  try {
    const client = clientFor(chain)
    if (!client || !address) return null
    const balance = await client.getBalance({ address })
    return formatEther(balance)
  } catch {
    return null
  }
}

async function sanitizeVault(row, includeBalances = false) {
  const address = row.address || row.wallet_address
  const vault = {
    id: row.id,
    address,
    wallet_address: address,
    label: row.label || 'Alpha Vault',
    chain_scope: row.chain_scope || 'evm',
    status: row.status || 'active',
    created_at: row.created_at,
    recent_txs: [],
  }
  if (includeBalances) {
    const [eth, base] = await Promise.all([balanceFor(address, 'eth'), balanceFor(address, 'base')])
    vault.balances = { eth, base }
  }
  return vault
}

async function createVault(supabase, user, privateKey, label = 'Alpha Vault') {
  const account = privateKeyToAccount(privateKey)
  if (!isAddress(account.address)) throw new Error('Invalid vault wallet')
  const row = {
    user_id: user.id,
    address: account.address.toLowerCase(),
    wallet_address: account.address.toLowerCase(),
    label,
    chain_scope: 'evm',
    encrypted_private_key: encryptPrivateKey(privateKey, user.id),
    status: 'active',
    updated_at: new Date().toISOString(),
  }
  let { data, error } = await supabase
    .from('alpha_vault_wallets')
    .upsert(row, { onConflict: 'user_id,address' })
    .select('id,address,wallet_address,label,chain_scope,status,created_at')
    .single()
  if (error) {
    const retry = await supabase
      .from('alpha_vault_wallets')
      .upsert(row, { onConflict: 'user_id,wallet_address' })
      .select('id,address,wallet_address,label,chain_scope,status,created_at')
      .single()
    data = retry.data
    error = retry.error
  }
  if (error) throw error
  return sanitizeVault(data)
}

export async function handleVaultAction(req, res, action) {
  if (!['create', 'import', 'list'].includes(action)) return res.status(404).json(safeError('Unknown vault action.'))

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:vault:${action}:${user.id}`, 12, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  if (!ALPHA_VAULT_ENABLED && action !== 'list') {
    return res.status(200).json({ ok: false, disabled: true, error: 'Alpha Vault is disabled by the global safety switch.' })
  }

  const supabase = createServiceClient()

  try {
    if (action === 'list') {
      const { data, error } = await supabase
        .from('alpha_vault_wallets')
        .select('id,address,wallet_address,label,chain_scope,status,created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      if (error) throw error
      const wallets = await Promise.all((data || []).map(row => sanitizeVault(row, true)))
      return res.status(200).json({ ok: true, wallets, enabled: ALPHA_VAULT_ENABLED })
    }

    if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))

    if (action === 'create') {
      const wallet = await createVault(supabase, user, generatePrivateKey(), req.body?.label || 'Alpha Vault')
      return res.status(200).json({ ok: true, wallet, warning: 'Fund this burner wallet only with what you are willing to mint with.' })
    }

    if (action === 'import') {
      const privateKey = String(req.body?.privateKey || '').trim()
      if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) return res.status(400).json(safeError('Private key format is invalid.'))
      const wallet = await createVault(supabase, user, privateKey, req.body?.label || 'Imported Alpha Vault')
      return res.status(200).json({ ok: true, wallet, warning: 'Use an isolated burner wallet. Never import your main wallet.' })
    }
  } catch (error) {
    console.error(`vault ${action} failed:`, error)
    return res.status(200).json(safeError('Alpha Vault could not complete this action.'))
  }
}
