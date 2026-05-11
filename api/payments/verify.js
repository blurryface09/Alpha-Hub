import { createPublicClient, formatEther, http, isAddress, parseEther } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { createServiceClient, requireUser, userOwnsWallet } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { writeAuditLog } from '../_lib/audit.js'
import { getPaymentChain, getPaymentChainKey, getPlan } from '../_lib/pricing.js'

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

  if (chainId === 8453) {
    return alchemy
      ? `https://base-mainnet.g.alchemy.com/v2/${alchemy}`
      : 'https://mainnet.base.org'
  }

  if (chainId === 84532) {
    return process.env.BASE_SEPOLIA_RPC_URL ||
      (alchemy ? `https://base-sepolia.g.alchemy.com/v2/${alchemy}` : 'https://sepolia.base.org')
  }

  return null
}

function getChain(chainId) {
  if (chainId === 8453) return base
  if (chainId === 84532) return baseSepolia
  return null
}

function getClient(chainId) {
  const chain = getChain(chainId)
  const rpc = getRpcUrl(chainId)
  if (!chain || !rpc) return null
  return createPublicClient({ chain, transport: http(rpc) })
}

async function findTransaction(txHash, chainId) {
  const client = getClient(chainId)
  if (!client) return null

  try {
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ])

    if (transaction && receipt) {
      return { chainId, transaction, receipt }
    }
  } catch {}

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
  const planConfig = getPlan(selectedPlan)
  const paymentChain = getPaymentChain()
  const paymentChainKey = getPaymentChainKey()
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

  if (!paymentChain) {
    return res.status(503).json({ error: 'Payment config incomplete: NEXT_PUBLIC_PAYMENT_CHAIN is required' })
  }

  if (!treasury || !isAddress(treasury)) {
    return res.status(503).json({ error: 'Payment is temporarily unavailable. Please try again later.' })
  }

  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  const submittedChainId = Number(chainId)
  if (!submittedChainId) {
    return res.status(400).json({ error: 'Payment chain is required' })
  }

  if (submittedChainId !== paymentChain.id) {
    return res.status(400).json({
      error: paymentChainKey === 'baseSepolia'
        ? 'Test payments must be sent on Base Sepolia'
        : 'Production payments must be sent on Base',
    })
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

  const verified = await findTransaction(txHash, paymentChain.id)
  if (!verified) {
    return res.status(404).json({ error: `Transaction not found or not confirmed yet on ${paymentChain.label}` })
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
  const expiresAt = new Date(now.getTime() + planConfig.durationDays * 24 * 60 * 60 * 1000)
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
      paymentChain: paymentChain.key,
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
    paymentChain: paymentChain.key,
    amount: amountEth,
    expiresAt: expiresAt.toISOString(),
    daysGranted: planConfig.durationDays,
  })
}
