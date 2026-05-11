import { createServiceClient, requireAdmin } from './_lib/auth.js'
import { writeAuditLog } from './_lib/audit.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'
import { PAYMENT_CONFIG, getPlan, getPlanDurationDays, PRICING_PLANS } from './_lib/pricing.js'

const PLAN_DAYS = Object.fromEntries(
  Object.values(PRICING_PLANS).map(plan => [plan.id, plan.durationDaysMonthly])
)

function validWallet(wallet) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))
}

async function activateSubscriptionFromPayment(supabase, payment) {
  const plan = getPlan(payment.plan)
  if (!plan) return { error: { message: 'Invalid payment plan' } }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + getPlanDurationDays(plan, payment.billing_cycle) * 24 * 60 * 60 * 1000)
  const payload = {
    user_id: payment.user_id,
    wallet_address: payment.wallet_address.toLowerCase(),
    plan: payment.plan,
    billing_cycle: payment.billing_cycle || 'monthly',
    status: 'active',
    tx_hash: payment.tx_hash,
    starts_at: now.toISOString(),
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified: true,
    amount_eth: Number(payment.amount_eth || 0),
    amount_usd: Number(payment.amount_usd || 0),
    chain_id: PAYMENT_CONFIG.chainId,
    updated_at: now.toISOString(),
  }

  const attempts = [
    payload,
    Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'starts_at')),
    Object.fromEntries(Object.entries(payload).filter(([key]) => !['starts_at', 'billing_cycle', 'amount_usd'].includes(key))),
  ]

  let result
  for (const row of attempts) {
    result = await supabase
      .from('subscriptions')
      .upsert(row, { onConflict: 'wallet_address' })
      .select()
      .single()
    if (!result.error) return { ...result, expiresAt }
  }
  return result
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const limited = await rateLimit(`rl:admin-subscriptions:${admin.id}`, 60, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const supabase = createServiceClient()

  if (req.method === 'GET') {
    const [{ data, error }, paymentsResult] = await Promise.all([
      supabase
      .from('subscriptions')
      .select('*')
        .order('created_at', { ascending: false }),
      supabase
        .from('payments')
        .select('*')
        .eq('status', 'pending_verification')
        .order('created_at', { ascending: false }),
    ])

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({
      subscriptions: data || [],
      pendingPayments: paymentsResult.error ? [] : paymentsResult.data || [],
      paymentsError: paymentsResult.error?.message || null,
    })
  }

  if (req.method === 'POST') {
    const adminAction = req.query.action || req.body?.action

    if (adminAction === 'approve-payment' || adminAction === 'reject-payment') {
      const { paymentId, txHash } = req.body || {}
      if (!paymentId && !txHash) return res.status(400).json({ error: 'paymentId or txHash is required' })

      const query = supabase.from('payments').select('*')
      const { data: payment, error: paymentError } = await (paymentId
        ? query.eq('id', paymentId)
        : query.eq('tx_hash', txHash)
      ).single()

      if (paymentError || !payment) return res.status(404).json({ error: 'Payment not found' })

      if (adminAction === 'reject-payment') {
        const { data, error } = await supabase
          .from('payments')
          .update({ status: 'rejected' })
          .eq('id', payment.id)
          .select()
          .single()
        if (error) return res.status(500).json({ error: error.message })

        await supabase
          .from('subscriptions')
          .update({ status: 'cancelled', verified: false, updated_at: new Date().toISOString() })
          .eq('tx_hash', payment.tx_hash)

        await writeAuditLog(supabase, {
          action: 'admin.payment.rejected',
          userId: admin.id,
          metadata: { paymentId: payment.id, txHash: payment.tx_hash, walletAddress: payment.wallet_address },
        })
        return res.status(200).json({ payment: data })
      }

      const { data: updatedPayment, error: updateError } = await supabase
        .from('payments')
        .update({ status: 'verified', verified_at: new Date().toISOString() })
        .eq('id', payment.id)
        .select()
        .single()
      if (updateError) return res.status(500).json({ error: updateError.message })

      const { data: subscription, error: subscriptionError, expiresAt } = await activateSubscriptionFromPayment(supabase, updatedPayment)
      if (subscriptionError) return res.status(500).json({ error: subscriptionError.message })

      await writeAuditLog(supabase, {
        action: 'admin.payment.approved',
        userId: admin.id,
        metadata: { paymentId: payment.id, txHash: payment.tx_hash, walletAddress: payment.wallet_address, expiresAt: expiresAt?.toISOString() },
      })
      return res.status(200).json({ payment: updatedPayment, subscription })
    }

    const { walletAddress, plan = 'monthly', reason } = req.body || {}
    if (!validWallet(walletAddress)) return res.status(400).json({ error: 'Valid walletAddress is required' })

    const planConfig = getPlan(plan)
    if (!planConfig) return res.status(400).json({ error: 'Invalid plan' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + getPlanDurationDays(planConfig, 'monthly') * 24 * 60 * 60 * 1000)
    const txHash = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert({
        wallet_address: walletAddress.toLowerCase(),
        plan,
        billing_cycle: 'monthly',
        tx_hash: txHash,
        chain_id: PAYMENT_CONFIG.chainId,
        amount_eth: 0,
        amount_usd: 0,
        starts_at: now.toISOString(),
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        verified: true,
        status: 'active',
      }, { onConflict: 'wallet_address' })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    await writeAuditLog(supabase, {
      action: 'admin.subscription.created',
      userId: admin.id,
      metadata: { walletAddress: walletAddress.toLowerCase(), plan, subscriptionId: data.id, reason: reason || 'manual_admin_grant' },
    })
    return res.status(200).json({ subscription: data })
  }

  if (req.method === 'PATCH') {
    const { id, plan, expiresAt } = req.body || {}
    if (!id) return res.status(400).json({ error: 'Subscription id is required' })

    let nextExpiry = expiresAt ? new Date(expiresAt) : null
    if (!nextExpiry) {
      if (!PLAN_DAYS[plan]) return res.status(400).json({ error: 'Plan is required to extend' })
      const { data: current, error: currentError } = await supabase
        .from('subscriptions')
        .select('expires_at')
        .eq('id', id)
        .single()
      if (currentError) return res.status(404).json({ error: 'Subscription not found' })
      const base = new Date(current.expires_at) > new Date() ? new Date(current.expires_at) : new Date()
      nextExpiry = new Date(base.getTime() + PLAN_DAYS[plan] * 24 * 60 * 60 * 1000)
    }

    const { data, error } = await supabase
      .from('subscriptions')
      .update({ expires_at: nextExpiry.toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    await writeAuditLog(supabase, {
      action: 'admin.subscription.updated',
      userId: admin.id,
      metadata: { subscriptionId: id, plan, expiresAt: nextExpiry.toISOString() },
    })
    return res.status(200).json({ subscription: data })
  }

  if (req.method === 'DELETE') {
    const { id } = req.query || {}
    if (!id) return res.status(400).json({ error: 'Subscription id is required' })
    const { error } = await supabase.from('subscriptions').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    await writeAuditLog(supabase, {
      action: 'admin.subscription.deleted',
      userId: admin.id,
      metadata: { subscriptionId: id },
    })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
