import { createPublicClient, formatEther, http, isAddress, parseEther } from 'viem'
import { base } from 'viem/chains'
import { createServiceClient, requireUser, userOwnsWallet } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { writeAuditLog } from '../_lib/audit.js'
import {
  PAYMENT_CONFIG,
  getActivationMode,
  getPlan,
  getPlanDurationDays,
  getPlanPriceUsd,
  subscriptionPlanForTier,
} from '../_lib/pricing.js'

const RECEIVER = PAYMENT_CONFIG.receiverAddress.toLowerCase()

function getRpcUrl() {
  const alchemy = process.env.ALCHEMY_API_KEY || process.env.VITE_ALCHEMY_API_KEY
  return process.env.BASE_RPC_URL ||
    (alchemy ? `https://base-mainnet.g.alchemy.com/v2/${alchemy}` : 'https://mainnet.base.org')
}

function getClient() {
  return createPublicClient({ chain: base, transport: http(getRpcUrl()) })
}

function normalizeBillingCycle(value) {
  return value === 'annual' ? 'annual' : 'monthly'
}

function validTxHash(txHash) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(txHash || ''))
}

function calculateExpectedEth(amountUsd, ethUsd) {
  return Math.ceil((Number(amountUsd) / Number(ethUsd)) * 1_000_000) / 1_000_000
}

function subscriptionPlanCandidates(plan, status) {
  if (status === 'free') {
    return [
      subscriptionPlanForTier('free'),
      'free',
      'basic',
      'starter',
      'trial',
      'monthly',
    ]
  }

  if (plan === 'elite' || plan === 'quarterly' || plan === 'founder') {
    return ['quarterly', 'elite', 'founder', 'monthly']
  }

  return ['monthly', 'pro', 'weekly']
}

async function upsertSubscription(supabase, payload) {
  const optionalColumns = [
    [],
    ['amount_usd'],
    ['starts_at', 'amount_usd'],
    ['starts_at', 'billing_cycle', 'amount_usd'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'chain_id'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'chain_id', 'updated_at'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'chain_id', 'updated_at', 'status'],
  ]
  const plans = subscriptionPlanCandidates(payload.plan, payload.status)

  let result
  const seen = new Set()
  for (const candidatePlan of plans) {
    if (seen.has(candidatePlan)) continue
    seen.add(candidatePlan)

    for (const omitColumns of optionalColumns) {
      const row = Object.fromEntries(
        Object.entries({ ...payload, plan: candidatePlan }).filter(([key]) => !omitColumns.includes(key))
      )
      result = await supabase
        .from('subscriptions')
        .upsert(row, { onConflict: 'wallet_address' })
        .select()
        .single()
      if (!result.error) return result

      const message = `${result.error.message || ''} ${result.error.details || ''} ${result.error.hint || ''}`
      const canRetryPlan = message.includes('subscriptions_plan_check') || message.toLowerCase().includes('violates check constraint')
      const canRetryColumn = message.toLowerCase().includes('column') || message.toLowerCase().includes('schema cache')
      if (!canRetryPlan && !canRetryColumn) return result
    }
  }
  return result
}

async function createPayment(req, res, user) {
  const limited = await rateLimit(`rl:payments:create:${user.id}`, 10, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const {
    planId,
    billingCycle: rawBillingCycle,
    walletAddress,
    txHash,
    chainId,
    amountEth,
    amountUsd,
    receiverAddress,
    ethUsd,
  } = req.body || {}

  const billingCycle = normalizeBillingCycle(rawBillingCycle)
  const plan = getPlan(planId)

  if (!plan || !walletAddress) {
    return res.status(400).json({ error: 'Valid planId and walletAddress are required' })
  }

  if (!isAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }

  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  const supabase = createServiceClient()

  if (plan.id === 'free') {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + getPlanDurationDays(plan, billingCycle) * 24 * 60 * 60 * 1000)
    const freeReference = `free_${user.id}_${Date.now()}`
    const { data, error } = await upsertSubscription(supabase, {
      user_id: user.id,
      wallet_address: walletAddress.toLowerCase(),
      plan: subscriptionPlanForTier('free'),
      billing_cycle: billingCycle,
      status: 'free',
      tx_hash: freeReference,
      starts_at: now.toISOString(),
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      verified: false,
      amount_eth: 0,
      amount_usd: 0,
      chain_id: PAYMENT_CONFIG.chainId,
      updated_at: now.toISOString(),
    })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ subscription: data, free: true })
  }

  if (!validTxHash(txHash)) return res.status(400).json({ error: 'Invalid transaction hash' })
  if (Number(chainId) !== PAYMENT_CONFIG.chainId) return res.status(400).json({ error: 'Payments must be sent on Base' })
  if (String(receiverAddress || '').toLowerCase() !== RECEIVER) return res.status(400).json({ error: 'Invalid payment receiver' })

  const expectedUsd = getPlanPriceUsd(plan, billingCycle)
  if (Number(amountUsd) !== expectedUsd) {
    return res.status(400).json({ error: 'Payment amount does not match selected plan' })
  }

  if (!Number.isFinite(Number(ethUsd)) || Number(ethUsd) <= 0) {
    return res.status(400).json({ error: 'Valid ETH/USD quote is required' })
  }

  const expectedEth = calculateExpectedEth(expectedUsd, ethUsd)
  if (Number(amountEth) < expectedEth) {
    return res.status(400).json({ error: 'ETH amount is lower than quoted plan price' })
  }

  const { data: existing } = await supabase
    .from('payments')
    .select('id')
    .eq('tx_hash', txHash)
    .maybeSingle()

  if (existing) return res.status(409).json({ error: 'Transaction already submitted' })

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .insert({
      user_id: user.id,
      wallet_address: walletAddress.toLowerCase(),
      plan: plan.id,
      billing_cycle: billingCycle,
      tx_hash: txHash,
      chain_id: PAYMENT_CONFIG.chainId,
      amount_eth: Number(amountEth),
      amount_usd: expectedUsd,
      token: PAYMENT_CONFIG.tokenSymbol,
      receiver_address: PAYMENT_CONFIG.receiverAddress,
      status: 'pending_verification',
    })
    .select()
    .single()

  if (paymentError) return res.status(500).json({ error: paymentError.message })

  const now = new Date()
  const { error: subscriptionError } = await upsertSubscription(supabase, {
    user_id: user.id,
    wallet_address: walletAddress.toLowerCase(),
    plan: subscriptionPlanForTier(plan.id),
    billing_cycle: billingCycle,
    status: 'pending_verification',
    tx_hash: txHash,
    starts_at: null,
    started_at: null,
    expires_at: null,
    verified: false,
    amount_eth: Number(amountEth),
    amount_usd: expectedUsd,
    chain_id: PAYMENT_CONFIG.chainId,
    updated_at: now.toISOString(),
  })

  if (subscriptionError) return res.status(500).json({ error: subscriptionError.message })

  await writeAuditLog(supabase, {
    action: 'payment.submitted',
    userId: user.id,
    metadata: { txHash, walletAddress: walletAddress.toLowerCase(), plan: plan.id, billingCycle, amountEth, amountUsd: expectedUsd },
  })

  return res.status(200).json({
    payment,
    activationMode: getActivationMode(),
    status: 'pending_verification',
  })
}

async function verifyPayment(req, res, user) {
  const limited = await rateLimit(`rl:payments:verify:${user.id}`, 10, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const { txHash, walletAddress, planId, billingCycle: rawBillingCycle } = req.body || {}
  const billingCycle = normalizeBillingCycle(rawBillingCycle)
  const plan = getPlan(planId)

  if (!validTxHash(txHash) || !walletAddress || !plan || plan.id === 'free') {
    return res.status(400).json({ error: 'Valid txHash, walletAddress, and paid planId are required' })
  }

  if (!isAddress(walletAddress)) return res.status(400).json({ error: 'Invalid wallet address' })
  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  const supabase = createServiceClient()
  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('*')
    .eq('tx_hash', txHash)
    .maybeSingle()

  if (paymentError) return res.status(500).json({ error: paymentError.message })
  if (!payment) return res.status(404).json({ error: 'Payment record not found' })
  if (payment.status === 'verified') return res.status(409).json({ error: 'Transaction already verified' })
  if (payment.wallet_address?.toLowerCase() !== walletAddress.toLowerCase()) {
    return res.status(400).json({ error: 'Payment wallet does not match request' })
  }

  const client = getClient()
  let transaction
  let receipt
  try {
    ;[transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ])
  } catch {
    return res.status(404).json({ error: 'Transaction not found or not confirmed yet on Base' })
  }

  if (receipt.status !== 'success') return res.status(400).json({ error: 'Transaction failed on-chain' })
  if (transaction.chainId && Number(transaction.chainId) !== PAYMENT_CONFIG.chainId) {
    return res.status(400).json({ error: 'Transaction is not on Base' })
  }
  if (transaction.to?.toLowerCase() !== RECEIVER) return res.status(400).json({ error: 'Transaction sent to wrong address' })
  if (transaction.from?.toLowerCase() !== walletAddress.toLowerCase()) {
    return res.status(400).json({ error: 'Transaction sender does not match wallet' })
  }

  const expectedValue = parseEther(String(payment.amount_eth))
  if (transaction.value < expectedValue) {
    return res.status(400).json({ error: `Insufficient payment. Expected at least ${payment.amount_eth} ETH` })
  }

  const mode = getActivationMode()
  const now = new Date()
  const durationDays = getPlanDurationDays(plan, billingCycle)
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000)
  const verifiedFields = {
    status: 'verified',
    verified_at: now.toISOString(),
  }

  await supabase.from('payments').update(verifiedFields).eq('tx_hash', txHash)

  if (mode === 'automatic') {
    const { data: subscription, error } = await upsertSubscription(supabase, {
      user_id: user.id,
      wallet_address: walletAddress.toLowerCase(),
      plan: subscriptionPlanForTier(plan.id),
      billing_cycle: billingCycle,
      status: 'active',
      tx_hash: txHash,
      starts_at: now.toISOString(),
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      verified: true,
      amount_eth: Number(formatEther(transaction.value)),
      amount_usd: getPlanPriceUsd(plan, billingCycle),
      chain_id: PAYMENT_CONFIG.chainId,
      updated_at: now.toISOString(),
    })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ subscription, status: 'active', expiresAt: expiresAt.toISOString() })
  }

  return res.status(200).json({ status: 'pending_verification', activationMode: mode })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const action = req.query.action
  if (action === 'create') return createPayment(req, res, user)
  if (action === 'verify') return verifyPayment(req, res, user)
  return res.status(404).json({ error: 'Payment action not found' })
}
