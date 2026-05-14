import crypto from 'crypto'
import { isAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createServiceClient, requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'

const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'

function safeError(error = 'Alpha Vault is temporarily unavailable.') {
  return { ok: false, error }
}

function encryptionKey(userId) {
  const secret = process.env.WALLET_ENCRYPTION_KEY
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

function sanitizeVault(row) {
  return {
    id: row.id,
    address: row.address,
    label: row.label || 'Alpha Vault',
    chain_scope: row.chain_scope || 'evm',
    status: row.status || 'active',
    created_at: row.created_at,
  }
}

async function createVault(supabase, user, privateKey, label = 'Alpha Vault') {
  const account = privateKeyToAccount(privateKey)
  if (!isAddress(account.address)) throw new Error('Invalid vault wallet')
  const row = {
    user_id: user.id,
    address: account.address.toLowerCase(),
    label,
    chain_scope: 'evm',
    encrypted_private_key: encryptPrivateKey(privateKey, user.id),
    status: 'active',
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .upsert(row, { onConflict: 'user_id,address' })
    .select('id,address,label,chain_scope,status,created_at')
    .single()
  if (error) throw error
  return sanitizeVault(data)
}

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase()
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
        .select('id,address,label,chain_scope,status,created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      if (error) throw error
      return res.status(200).json({ ok: true, wallets: (data || []).map(sanitizeVault), enabled: ALPHA_VAULT_ENABLED })
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
