import crypto from 'crypto'
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, isAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createServiceClient, requireUser } from './auth.js'
import { rateLimit, sendRateLimit } from './redis.js'

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

function encryptionKey(userId) {
  const secret = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
  if (!secret) throw new Error('Vault encryption is not configured')
  return crypto.pbkdf2Sync(secret, userId, 100_000, 32, 'sha256')
}

function decryptPrivateKey(encryptedB64, userId) {
  const key = encryptionKey(userId)
  const buf = Buffer.from(encryptedB64, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8')
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

      const { vaultWalletId, toAddress, type, contractAddress, tokenId, amount, chain: chainKey = 'eth' } = req.body || {}

      if (!vaultWalletId) return res.status(400).json(safeError('vaultWalletId is required.'))
      if (!toAddress || !isAddress(toAddress)) return res.status(400).json(safeError('Valid toAddress is required.'))
      if (!['native_eth', 'erc721', 'erc20'].includes(type)) return res.status(400).json(safeError('type must be native_eth, erc721, or erc20.'))

      const rpcUrl = RPCS[chainKey]
      if (!rpcUrl) return res.status(400).json(safeError(`Chain "${chainKey}" is not supported for vault withdrawals.`))

      // Ownership verification — row must belong to this user
      const { data: vaultRow, error: vaultErr } = await supabase
        .from('alpha_vault_wallets')
        .select('id,address,wallet_address,encrypted_private_key,status,label')
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
        // Decrypt private key — stays server-side, never returned
        const privateKey = decryptPrivateKey(vaultRow.encrypted_private_key, user.id)
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
          const valueWei = BigInt(Math.round(parseFloat(amount || '0') * 1e18))
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

        // Log success to mint_log
        try {
          await supabase.from('mint_log').insert({
            user_id: user.id,
            project_id: null,
            wallet_address: vaultAddress,
            chain: chainKey,
            tx_hash: txHash,
            status: 'withdrawal_ok',
            executed_at: new Date().toISOString(),
          })
        } catch (_) {}

        return res.status(200).json({ ok: true, txHash })

      } catch (err) {
        console.error('[vault-withdraw] tx_error', { userId: user.id, vaultWalletId, error: err.message?.slice(0, 200) })

        // Log failure to mint_log
        try {
          await supabase.from('mint_log').insert({
            user_id: user.id,
            project_id: null,
            wallet_address: vaultAddress || 'unknown',
            chain: chainKey,
            status: 'withdrawal_failed',
            error_message: err.shortMessage || err.message?.slice(0, 200),
            executed_at: new Date().toISOString(),
          })
        } catch (_) {}

        return res.status(200).json(safeError(err.shortMessage || err.message || 'Withdrawal failed. Verify vault ETH balance for gas.'))
      }
    }
  } catch (error) {
    console.error(`vault ${action} failed:`, error)
    return res.status(200).json(safeError('Alpha Vault could not complete this action.'))
  }
}
