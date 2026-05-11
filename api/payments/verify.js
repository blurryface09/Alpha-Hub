import { createPublicClient, formatEther, http, isAddress, parseEther } from 'viem'
import { mainnet, base, bsc } from 'viem/chains'
import { createServiceClient, requireUser, userOwnsWallet } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { writeAuditLog } from '../_lib/audit.js'

const PLAN_CONFIG = {
  weekly: { days: 7, priceEth: '0.0015' },
  monthly: { days: 30, priceEth: '0.005' },
  quarterly: { days: 90, priceEth: '0.012' },
}

function getTreasuryAddress() {
  return (
    process.env.TREASURY_ADDRESS ||
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
    process.env.VITE_TREASURY_ADDRESS ||
    process.env.VITE_RECEIVER_WALLET ||
    ''
  ).toLowerCase()
}

function getRpcUrl(chainId) {
  const alchemy = process.env.ALCHEMY_API_KEY || process.env.VITE_ALCHEMY_API_KEY

  if (chainId === 1) {
    return alchemy
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemy}`
      : 'https://ethereum-rpc.publicnode.com'
  }

  if (chainId === 8453) {
    return alchemy
      ? `https://base-mainnet.g.alchemy.com/v2/${alchemy}`
      : 'https://mainnet.base.org'
  }

  if (chainId === 56) return 'https://bsc-dataseed.binance.org'

  return null
}

function getChain(chainId) {
  if (chainId === 1) return mainnet
  if (chainId === 8453) return base
  if (chainId === 56) return bsc
  return null
}

function getClient(chainId) {
  const chain = getChain(chainId)
  const rpc = getRpcUrl(chainId)
  if (!chain || !rpc) return null
  return createPublicClient({ chain, transport: http(rpc) })
}

async function findTransaction(txHash, preferredChainId) {
  const chainIds = preferredChainId ? [preferredChainId] : [1, 8453, 56]

  for (const chainId of chainIds) {
    const client = getClient(chainId)
    if (!client) continue

    try {
      const [transaction, receipt] = await Promise.all([
        client.getTransaction({ hash: txHash }),
        client.getTransactionReceipt({ hash: txHash }),
      ])

      if (transaction && receipt) {
        return { chainId, transaction, receipt }
      }
    } catch {}
  }

  return null
}

async function activateSubscription(supabase, row) {
  const write = (payload) => supabase
    .from('subscriptions')
    .upsert(payload, { onConflict: 'wallet_address' })
    .select()
    .single()

  const result = await write(row)
  if (!result.error) return result

  const message = `${result.error.message || ''} ${result.error.details || ''}`
  if (!message.toLowerCase().includes('status')) return result

  const { status, ...fallbackRow } = row
  console.warn('subscriptions.status column missing; activating without status column')
  return write(fallbackRow)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:payments:verify:${user.id}`, 10, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const { txHash, walletAddress, planId, plan, chainId } = req.body || {}
  const selectedPlan = planId || plan
  const planConfig = PLAN_CONFIG[selectedPlan]
  const treasury = getTreasuryAddress()

  if (!txHash || !walletAddress || !selectedPlan) {
    return res.status(400).json({ error: 'Missing txHash, walletAddress, or planId' })
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return res.status(400).json({ error: 'Invalid transaction hash' })
  }

  if (!isAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }

  if (!planConfig) {
    return res.status(400).json({ error: 'Invalid plan' })
  }

  if (!treasury || !isAddress(treasury)) {
    return res.status(503).json({ error: 'Payment is temporarily unavailable. Please try again later.' })
  }

  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  const preferredChainId = Number(chainId) || null
  if (preferredChainId && !getChain(preferredChainId)) {
    return res.status(400).json({ error: 'Unsupported payment network' })
  }

  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('tx_hash', txHash)
    .maybeSingle()

  if (existing) {
    return res.status(409).json({ error: 'Transaction already used' })
  }

  const verified = await findTransaction(txHash, preferredChainId)
  if (!verified) {
    return res.status(404).json({ error: 'Transaction not found or not confirmed yet' })
  }

  const { chainId: verifiedChainId, transaction, receipt } = verified
  const expectedValue = parseEther(planConfig.priceEth)

  if (receipt.status !== 'success') {
    return res.status(400).json({ error: 'Transaction failed on-chain' })
  }

  if (transaction.to?.toLowerCase() !== treasury) {
    return res.status(400).json({ error: 'Transaction sent to wrong address' })
  }

  if (transaction.from?.toLowerCase() !== walletAddress.toLowerCase()) {
    return res.status(400).json({ error: 'Transaction sender does not match wallet' })
  }

  if (transaction.value < expectedValue) {
    return res.status(400).json({
      error: `Insufficient payment. Expected ${planConfig.priceEth} ETH`,
    })
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000)
  const amountEth = Number(formatEther(transaction.value))

  const { data: subscription, error: upsertError } = await activateSubscription(supabase, {
    wallet_address: walletAddress.toLowerCase(),
    plan: selectedPlan,
    tx_hash: txHash,
    chain_id: verifiedChainId,
    amount_eth: amountEth,
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified: true,
    status: 'active',
    user_id: user.id,
  })

  if (upsertError) {
    console.error('payment verify subscription upsert error:', upsertError)
    return res.status(500).json({ error: 'Failed to activate subscription' })
  }

  await writeAuditLog(supabase, {
    action: 'payment.verified',
    userId: user.id,
    metadata: {
      walletAddress: walletAddress.toLowerCase(),
      txHash,
      plan: selectedPlan,
      chainId: verifiedChainId,
      amountEth,
      expiresAt: expiresAt.toISOString(),
    },
  })

  return res.status(200).json({
    success: true,
    subscription,
    txHash,
    plan: selectedPlan,
    chainId: verifiedChainId,
    amount: amountEth,
    expiresAt: expiresAt.toISOString(),
    daysGranted: planConfig.days,
  })
}
