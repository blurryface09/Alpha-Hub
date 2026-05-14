/**
 * POST   /api/wallet  — encrypt and store a minting wallet private key
 * DELETE /api/wallet  — remove the stored wallet
 * GET    /api/wallet  — return the wallet address (never the key)
 *
 * Private keys are encrypted with AES-256-GCM using WALLET_ENCRYPTION_KEY (server-only env var).
 * The raw key is NEVER logged or returned to the client.
 */

import crypto from 'crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { createAnonClient, createServiceClient } from './_lib/auth.js'
import { writeAuditLog } from './_lib/audit.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'

// Derives a 32-byte encryption key per user so one leaked encrypted blob can't
// be decrypted without knowing both WALLET_ENCRYPTION_KEY and the user's ID.
function deriveKey(userId) {
  const master = process.env.WALLET_ENCRYPTION_KEY
  if (!master) throw new Error('WALLET_ENCRYPTION_KEY not set on server')
  return crypto.pbkdf2Sync(master, userId, 100_000, 32, 'sha256')
}

function encrypt(plaintext, userId) {
  const key = deriveKey(userId)
  const iv = crypto.randomBytes(12) // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag() // 16 bytes
  // Layout: [iv(12)] [tag(16)] [ciphertext]
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

function decrypt(blob, userId) {
  const key = deriveKey(userId)
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8')
}

async function authUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!token) return null
  const anonClient = createAnonClient()
  const { data: { user }, error } = await anonClient.auth.getUser(token)
  return error ? null : user
}

export default async function handler(req, res) {
  const user = await authUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const limited = await rateLimit(`rl:wallet:${user.id}`, req.method === 'GET' ? 60 : 10, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)
  const supabase = createServiceClient()

  // GET — return wallet address only
  if (req.method === 'GET') {
    const { data } = await supabase
      .from('minting_wallets')
      .select('wallet_address, created_at')
      .eq('user_id', user.id)
      .single()
    return res.status(200).json({ wallet: data || null })
  }

  // POST — store new wallet
  if (req.method === 'POST') {
    const { private_key } = req.body || {}
    if (!private_key) return res.status(400).json({ error: 'private_key required' })

    // Normalize key — ensure 0x prefix
    const key = private_key.trim().startsWith('0x')
      ? private_key.trim()
      : '0x' + private_key.trim()

    let account
    try {
      account = privateKeyToAccount(key)
    } catch {
      return res.status(400).json({ error: 'Invalid private key' })
    }

    const encrypted = encrypt(key, user.id)

    const { error } = await supabase.from('minting_wallets').upsert({
      user_id: user.id,
      encrypted_key: encrypted,
      wallet_address: account.address,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    if (error) return res.status(500).json({ error: error.message })
    await writeAuditLog(supabase, {
      action: 'minting_wallet.saved',
      userId: user.id,
      metadata: { walletAddress: account.address },
    })

    // Return ONLY the address — never echo the key
    return res.status(200).json({ address: account.address })
  }

  // DELETE — remove wallet
  if (req.method === 'DELETE') {
    await supabase.from('minting_wallets').delete().eq('user_id', user.id)
    await writeAuditLog(supabase, {
      action: 'minting_wallet.deleted',
      userId: user.id,
    })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}

// Export decrypt helper for use by auto-mint cron
export { decrypt }
