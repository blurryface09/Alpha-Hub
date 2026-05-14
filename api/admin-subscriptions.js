import { createServiceClient, requireAdmin } from './_lib/auth.js'
import { writeAuditLog } from './_lib/audit.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'
import { PAYMENT_CONFIG, getPlan, getPlanDurationDays, subscriptionPlanForTier, PRICING_PLANS } from './_lib/pricing.js'

const PLAN_DAYS = Object.fromEntries(
  Object.values(PRICING_PLANS).map(plan => [plan.id, plan.durationDaysMonthly])
)

function validWallet(wallet) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))
}

function subscriptionPlanCandidates(plan, status) {
  if (status === 'free' || plan === 'free') return ['free', 'basic', 'starter', 'trial', 'monthly']
  if (plan === 'elite' || plan === 'quarterly' || plan === 'founder') return ['quarterly', 'elite', 'founder', 'monthly']
  return ['monthly', 'pro', 'weekly']
}

function shouldRetrySubscriptionWrite(error) {
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
  return message.includes('schema cache') ||
    message.includes('column') ||
    message.includes('check constraint') ||
    message.includes('violates')
}

function publicSubscriptionError(error) {
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
  if (message.includes('schema cache') || message.includes('column') || message.includes('check constraint')) {
    return 'Could not update subscription. Access fallback was not available.'
  }
  return 'Could not update subscription. Please try again.'
}

function subscriptionFromPayment(payment) {
  const plan = getPlan(payment.plan)
  const startsAt = payment.verified_at || payment.created_at || new Date().toISOString()
  const expiresAt = new Date(new Date(startsAt).getTime() + getPlanDurationDays(plan, payment.billing_cycle) * 24 * 60 * 60 * 1000)

  return {
    id: `payment_${payment.id}`,
    user_id: payment.user_id,
    wallet_address: payment.wallet_address,
    plan: payment.plan,
    billing_cycle: payment.billing_cycle || 'monthly',
    status: 'active',
    tx_hash: payment.tx_hash,
    starts_at: startsAt,
    started_at: startsAt,
    expires_at: expiresAt.toISOString(),
    verified: true,
    source: 'payment',
  }
}

async function createVerifiedManualPayment(supabase, { walletAddress, plan, txHash }) {
  const planConfig = getPlan(plan)
  const now = new Date().toISOString()
  return supabase
    .from('payments')
    .insert({
      wallet_address: walletAddress.toLowerCase(),
      plan: planConfig.id,
      billing_cycle: 'monthly',
      tx_hash: txHash,
      chain_id: PAYMENT_CONFIG.chainId,
      amount_eth: 0,
      amount_usd: 0,
      token: PAYMENT_CONFIG.tokenSymbol,
      receiver_address: PAYMENT_CONFIG.receiverAddress,
      status: 'verified',
      verified_at: now,
    })
    .select()
    .single()
}

async function upsertSubscription(supabase, payload) {
  const optionalColumns = [
    [],
    ['amount_usd'],
    ['amount_usd', 'amount_eth'],
    ['starts_at', 'amount_usd', 'amount_eth'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'amount_eth'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'amount_eth', 'chain_id'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'amount_eth', 'chain_id', 'updated_at'],
    ['starts_at', 'billing_cycle', 'amount_usd', 'amount_eth', 'chain_id', 'updated_at', 'status'],
  ]
  const candidates = subscriptionPlanCandidates(payload.plan, payload.status)
  const seen = new Set()
  let result

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)

    for (const omit of optionalColumns) {
      const row = Object.fromEntries(
        Object.entries({ ...payload, plan: candidate }).filter(([key]) => !omit.includes(key))
      )
      result = await supabase
        .from('subscriptions')
        .upsert(row, { onConflict: 'wallet_address' })
        .select()
        .single()

      if (!result.error) return result
      if (!shouldRetrySubscriptionWrite(result.error)) return result
    }
  }

  return result
}

async function activateSubscriptionFromPayment(supabase, payment) {
  const plan = getPlan(payment.plan)
  if (!plan) return { error: { message: 'Invalid payment plan' } }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + getPlanDurationDays(plan, payment.billing_cycle) * 24 * 60 * 60 * 1000)
  const payload = {
    user_id: payment.user_id,
    wallet_address: payment.wallet_address.toLowerCase(),
    plan: subscriptionPlanForTier(payment.plan),
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

  const result = await upsertSubscription(supabase, payload)
  return result.error ? result : { ...result, expiresAt }
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const limited = await rateLimit(`rl:admin-subscriptions:${admin.id}`, 60, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const supabase = createServiceClient()

  if (req.method === 'GET') {
    const [{ data, error }, paymentsResult, verifiedPaymentsResult] = await Promise.all([
      supabase
      .from('subscriptions')
      .select('*')
        .order('created_at', { ascending: false }),
      supabase
        .from('payments')
        .select('*')
        .eq('status', 'pending_verification')
        .order('created_at', { ascending: false }),
      supabase
        .from('payments')
        .select('*')
        .eq('status', 'verified')
        .order('verified_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }),
    ])

    if (error) return res.status(500).json({ error: error.message })
    const existingKeys = new Set((data || []).map(item => `${item.wallet_address}:${item.tx_hash}`))
    const paymentSubscriptions = (verifiedPaymentsResult.error ? [] : verifiedPaymentsResult.data || [])
      .map(payment => subscriptionFromPayment(payment))
      .filter(Boolean)
      .filter(item => !existingKeys.has(`${item.wallet_address}:${item.tx_hash}`))

    return res.status(200).json({
      subscriptions: [...(data || []), ...paymentSubscriptions],
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
      const resolvedSubscription = subscriptionError ? subscriptionFromPayment(updatedPayment) : subscription

      await writeAuditLog(supabase, {
        action: 'admin.payment.approved',
        userId: admin.id,
        metadata: {
          paymentId: payment.id,
          txHash: payment.tx_hash,
          walletAddress: payment.wallet_address,
          expiresAt: expiresAt?.toISOString() || resolvedSubscription.expires_at,
          subscriptionFallback: !!subscriptionError,
        },
      })
      return res.status(200).json({ payment: updatedPayment, subscription: resolvedSubscription })
    }

    const { walletAddress, plan = 'monthly', reason } = req.body || {}
    if (!validWallet(walletAddress)) return res.status(400).json({ error: 'Valid walletAddress is required' })

    const planConfig = getPlan(plan)
    if (!planConfig) return res.status(400).json({ error: 'Invalid plan' })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + getPlanDurationDays(planConfig, 'monthly') * 24 * 60 * 60 * 1000)
    const txHash = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const { data, error } = await upsertSubscription(supabase, {
      wallet_address: walletAddress.toLowerCase(),
      plan: subscriptionPlanForTier(plan),
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
    })

    let subscription = data
    let usedFallback = false
    if (error) {
      const paymentResult = await createVerifiedManualPayment(supabase, {
        walletAddress,
        plan: planConfig.id,
        txHash,
      })

      if (paymentResult.error) {
        return res.status(500).json({ error: publicSubscriptionError(error) })
      }

      subscription = subscriptionFromPayment(paymentResult.data)
      usedFallback = true
    }

    await writeAuditLog(supabase, {
      action: 'admin.subscription.created',
      userId: admin.id,
      metadata: {
        walletAddress: walletAddress.toLowerCase(),
        plan,
        subscriptionId: subscription.id,
        reason: reason || 'manual_admin_grant',
        subscriptionFallback: usedFallback,
      },
    })
    return res.status(200).json({ subscription })
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
