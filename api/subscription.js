import { createServiceClient, requireUser, userOwnsWallet } from './_lib/auth.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'
import { getPlan, getPlanDurationDays } from './_lib/pricing.js'

function activeSubscriptionFromPayment(payment) {
  if (!payment || payment.status !== 'verified') return null

  const plan = getPlan(payment.plan)
  if (!plan) return null

  const verifiedAt = payment.verified_at || payment.created_at
  const startsAt = verifiedAt ? new Date(verifiedAt) : new Date()
  const billingCycle = payment.billing_cycle === 'annual' ? 'annual' : 'monthly'
  const expiresAt = new Date(startsAt.getTime() + getPlanDurationDays(plan, billingCycle) * 24 * 60 * 60 * 1000)

  return {
    id: `payment_${payment.id}`,
    user_id: payment.user_id,
    wallet_address: payment.wallet_address,
    plan: plan.id,
    billing_cycle: billingCycle,
    status: expiresAt > new Date() ? 'active' : 'expired',
    tx_hash: payment.tx_hash,
    starts_at: startsAt.toISOString(),
    started_at: startsAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified: true,
    source: 'payment',
  }
}

function defaultFreeSubscription(user, walletAddress) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  return {
    id: `free_${walletAddress}`,
    user_id: user.id,
    wallet_address: walletAddress,
    plan: 'free',
    billing_cycle: 'monthly',
    status: 'free',
    starts_at: now.toISOString(),
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified: true,
    source: 'default_free',
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:subscription:${user.id}`, 30, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const walletAddress = String(req.query.walletAddress || '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid walletAddress is required' })
  }

  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })

  const now = new Date()
  if (data?.status === 'active' && data?.expires_at && new Date(data.expires_at) > now) {
    return res.status(200).json({ subscription: data })
  }

  if (data?.status === 'free' || data?.plan === 'free' || data?.plan === 'weekly') {
    return res.status(200).json({ subscription: data })
  }

  const { data: payment } = await supabase
    .from('payments')
    .select('*')
    .eq('wallet_address', walletAddress)
    .eq('status', 'verified')
    .order('verified_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const paymentSubscription = activeSubscriptionFromPayment(payment)
  return res.status(200).json({
    subscription: paymentSubscription || defaultFreeSubscription(user, walletAddress),
  })
}
