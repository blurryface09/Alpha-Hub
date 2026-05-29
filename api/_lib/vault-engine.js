import crypto from 'crypto'
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, isAddress, parseEther } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createServiceClient, requireUser } from './auth.js'
import { rateLimit, sendRateLimit, cacheGet, cacheSet } from './redis.js'

// ABI fragments for on-chain transfers (server-side signing only)
const ERC721_TRANSFER_ABI = [{
  name: 'safeTransferFrom',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
  ],
  outputs: [],
}]

const ERC20_TRANSFER_ABI = [{
  name: 'transfer',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ type: 'bool' }],
}]

const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'
const RPCS = {
  eth: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
}

function safeError(error = 'Alpha Vault is temporarily unavailable.') {
  return { ok: false, error }
}

// VAULT-1+VAULT-2: Key versioning — supports rotation without losing access to existing vaults.
// Canonical env var: WALLET_ENCRYPTION_KEY (use this in both Vercel and Railway — same value).
// ALPHA_VAULT_ENCRYPTION_KEY is accepted as a legacy alias for v1 only.
// To rotate: add WALLET_ENCRYPTION_KEY_V2 + set VAULT_KEY_VERSION=2, then run a re-encryption
// migration (re-read each row with v1, re-write with v2, update key_version column).
const CURRENT_KEY_VERSION = parseInt(process.env.VAULT_KEY_VERSION || '1', 10)

function encryptionKey(userId, version = CURRENT_KEY_VERSION) {
  const versionedKey = version > 1 ? process.env[`WALLET_ENCRYPTION_KEY_V${version}`] : null
  const secret = versionedKey
    || process.env.WALLET_ENCRYPTION_KEY        // canonical — set this in both Vercel + Railway
    || process.env.ALPHA_VAULT_ENCRYPTION_KEY   // legacy alias (v1 backwards compat only)
  if (!secret) throw new Error(`Vault encryption key not configured (WALLET_ENCRYPTION_KEY or WALLET_ENCRYPTION_KEY_V${version})`)
  return crypto.pbkdf2Sync(secret, userId, 100_000, 32, 'sha256')
}

function decryptPrivateKey(encryptedB64, userId, keyVersion = 1) {
  const key = encryptionKey(userId, keyVersion)
  const buf = Buffer.from(encryptedB64, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8')
}

function encryptPrivateKey(privateKey, userId) {
  const version = CURRENT_KEY_VERSION
  const key = encryptionKey(userId, version)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    encryptedB64: Buffer.concat([iv, tag, encrypted]).toString('base64'),
    keyVersion: version,
  }
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
  const { encryptedB64, keyVersion } = encryptPrivateKey(privateKey, user.id)
  const row = {
    user_id: user.id,
    address: account.address.toLowerCase(),
    wallet_address: account.address.toLowerCase(),
    label,
    chain_scope: 'evm',
    encrypted_private_key: encryptedB64,
    key_version: keyVersion,
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
  if (!['create', 'import', 'list', 'withdraw'].includes(action)) return res.status(404).json(safeError('Unknown vault action.'))

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

    if (action === 'withdraw') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))

      // Stricter rate limit for withdrawals — 5 per 5 minutes per user
      const wLimited = await rateLimit(`rl:vault:withdraw:strict:${user.id}`, 5, 300)
      if (!wLimited.allowed) return sendRateLimit(res, wLimited)

      const { vaultWalletId, toAddress, type, contractAddress, tokenId, amount, chain: chainKey = 'eth', idempotencyKey } = req.body || {}

      if (!vaultWalletId) return res.status(400).json(safeError('vaultWalletId is required.'))
      if (!toAddress || !isAddress(toAddress)) return res.status(400).json(safeError('Valid toAddress is required.'))
      if (!['native_eth', 'erc721', 'erc20'].includes(type)) return res.status(400).json(safeError('type must be native_eth, erc721, or erc20.'))

      // VAULT-4: Idempotency / replay protection.
      // Client sends a unique idempotencyKey (UUID) per withdrawal attempt.
      // If a tx was already broadcast for this key, return the cached result — no second broadcast.
      if (idempotencyKey && /^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) {
        const idemCacheKey = `vault:withdraw:idem:${user.id}:${idempotencyKey}`
        const cached = await cacheGet(idemCacheKey)
        if (cached) {
          console.log('[vault-withdraw] idempotency cache hit', { userId: user.id, idempotencyKey })
          return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached)
        }
      }

      const rpcUrl = RPCS[chainKey]
      if (!rpcUrl) return res.status(400).json(safeError(`Chain "${chainKey}" is not supported for vault withdrawals.`))

      // Ownership verification — row must belong to this user
      const { data: vaultRow, error: vaultErr } = await supabase
        .from('alpha_vault_wallets')
        .select('id,address,wallet_address,encrypted_private_key,key_version,status,label')
        .eq('id', vaultWalletId)
        .eq('user_id', user.id)
        .single()

      if (vaultErr || !vaultRow) {
        console.warn('[vault-withdraw] ownership_check_failed', { userId: user.id, vaultWalletId })
        return res.status(403).json(safeError('Vault wallet not found or access denied.'))
      }
      if (vaultRow.status !== 'active') return res.status(400).json(safeError('This vault wallet is not active.'))
      if (!vaultRow.encrypted_private_key) return res.status(400).json(safeError('Vault wallet has no signing key stored.'))

      const vaultAddress = vaultRow.address || vaultRow.wallet_address

      console.log('[vault-withdraw] attempt', {
        userId: user.id,
        vaultWalletId,
        vaultAddress: vaultAddress?.slice(0, 10),
        type,
        chain: chainKey,
        toAddress: toAddress?.slice(0, 10),
      })

      let txHash = null
      try {
        // Decrypt private key — stays server-side, never returned.
        // VAULT-1: pass key_version so the correct versioned key is used for decryption.
        const privateKey = decryptPrivateKey(vaultRow.encrypted_private_key, user.id, vaultRow.key_version || 1)
        const account = privateKeyToAccount(privateKey)

        const chainId = chainKey === 'base' ? 8453 : 1
        const viemChain = {
          id: chainId,
          name: chainKey === 'base' ? 'Base' : 'Ethereum',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
        }

        const walletClient = createWalletClient({
          account,
          chain: viemChain,
          transport: http(rpcUrl, { timeout: 30000 }),
        })

        if (type === 'native_eth') {
          // VAULT-3: use parseEther() — IEEE 754 float math (parseFloat * 1e18) loses
          // precision for amounts like 0.1 ETH. parseEther() handles this correctly.
          let valueWei
          try { valueWei = parseEther(String(amount || '0')) } catch {
            return res.status(400).json(safeError('Invalid ETH amount.'))
          }
          if (valueWei <= 0n) return res.status(400).json(safeError('Invalid withdrawal amount — must be > 0.'))
          txHash = await walletClient.sendTransaction({ to: toAddress, value: valueWei })

        } else if (type === 'erc721') {
          if (!contractAddress || tokenId === undefined || tokenId === null) {
            return res.status(400).json(safeError('contractAddress and tokenId are required for ERC721 withdrawal.'))
          }
          const data = encodeFunctionData({
            abi: ERC721_TRANSFER_ABI,
            functionName: 'safeTransferFrom',
            args: [vaultAddress, toAddress, BigInt(tokenId)],
          })
          txHash = await walletClient.sendTransaction({ to: contractAddress, data })

        } else if (type === 'erc20') {
          if (!contractAddress || !amount) {
            return res.status(400).json(safeError('contractAddress and amount are required for ERC20 withdrawal.'))
          }
          const data = encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: 'transfer',
            args: [toAddress, BigInt(amount)],
          })
          txHash = await walletClient.sendTransaction({ to: contractAddress, data })
        }

        console.log('[vault-withdraw] success', {
          userId: user.id,
          vaultAddress: vaultAddress?.slice(0, 10),
          type,
          chain: chainKey,
          txHash: txHash?.slice(0, 14),
        })

        // MON-3: audit log to mint_log — failure is logged to stdout as fallback so
        // the tx_hash is never silently lost even during a Supabase outage.
        const auditRow = {
          user_id: user.id,
          project_id: null,
          wallet_address: vaultAddress,
          chain: chainKey,
          tx_hash: txHash,
          status: 'withdrawal_ok',
          executed_at: new Date().toISOString(),
        }
        try {
          await supabase.from('mint_log').insert(auditRow)
        } catch (auditErr) {
          console.error('[vault-withdraw] audit-log-failed — tx went through but mint_log write failed', {
            txHash, vaultAddress: vaultAddress?.slice(0, 10), chain: chainKey, err: auditErr.message,
          })
        }

        // VAULT-4: Cache idempotency result for 10 minutes so duplicate requests return
        // the same txHash without triggering a second broadcast.
        if (idempotencyKey && /^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) {
          const idemCacheKey = `vault:withdraw:idem:${user.id}:${idempotencyKey}`
          await cacheSet(idemCacheKey, JSON.stringify({ ok: true, txHash }), 600)
        }

        return res.status(200).json({ ok: true, txHash })

      } catch (err) {
        console.error('[vault-withdraw] tx_error', { userId: user.id, vaultWalletId, error: err.message?.slice(0, 200) })

        // MON-3: log failure audit — same fallback as success path
        const failAuditRow = {
          user_id: user.id,
          project_id: null,
          wallet_address: vaultAddress || 'unknown',
          chain: chainKey,
          status: 'withdrawal_failed',
          error_message: (err.shortMessage || err.message || '').slice(0, 200),
          executed_at: new Date().toISOString(),
        }
        try {
          await supabase.from('mint_log').insert(failAuditRow)
        } catch (auditErr) {
          console.error('[vault-withdraw] failure-audit-log-failed', { err: auditErr.message })
        }

        return res.status(200).json(safeError(err.shortMessage || err.message || 'Withdrawal failed. Verify vault ETH balance for gas.'))
      }
    }
  } catch (error) {
    // MON-4: Return 500 for unhandled exceptions so callers and monitors can
    // distinguish a server crash from a handled business-logic failure (200+ok:false).
    console.error(`vault ${action} failed:`, error)
    return res.status(500).json(safeError('Alpha Vault could not complete this action.'))
  }
}
