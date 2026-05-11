import { createServiceClient, requireAdmin } from './_lib/auth.js'
import { writeAuditLog } from './_lib/audit.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'
import { getPaymentChainKey, getPlan, PRICING_PLANS } from './_lib/pricing.js'

const PLAN_DAYS = Object.fromEntries(
  Object.values(PRICING_PLANS).map(plan => [plan.id, plan.durationDays])
)

function validWallet(wallet) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const limited = await rateLimit(`rl:admin-subscriptions:${admin.id}`, 60, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const supabase = createServiceClient()

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ subscriptions: data || [] })
  }

  if (req.method === 'POST') {
    const { walletAddress, plan = 'monthly', reason } = req.body || {}
    if (!validWallet(walletAddress)) return res.status(400).json({ error: 'Valid walletAddress is required' })

    const planConfig = getPlan(plan)
    if (!planConfig) return res.status(400).json({ error: 'Invalid plan' })

    if (reason === 'admin_test_grant' && getPaymentChainKey() !== 'baseSepolia' && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Test grants are disabled in production payment mode' })
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + planConfig.durationDays * 24 * 60 * 60 * 1000)
    const txHash = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert({
        wallet_address: walletAddress.toLowerCase(),
        plan,
        tx_hash: txHash,
        chain_id: 1,
        amount_eth: 0,
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
