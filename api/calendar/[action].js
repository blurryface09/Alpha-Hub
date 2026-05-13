import etherscanHandler from '../etherscan.js'
import { createServiceClient, getBearerToken, isAdminUser, createAnonClient, requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { runCalendarSync, getCalendarStatus } from '../../src/server/calendar/sync.js'
import { normalizeProject } from '../../src/server/calendar/normalize.js'

async function getOptionalUser(req) {
  const token = getBearerToken(req)
  if (!token) return null
  const supabase = createAnonClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  return user || null
}

async function canRunSync(req, res) {
  const cronSecret = process.env.CRON_SECRET
  const headerSecret = req.headers['x-cron-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (cronSecret && headerSecret === cronSecret) return true

  const user = await getOptionalUser(req)
  if (user && isAdminUser(user)) return true

  res.status(403).json({ ok: false, error: 'Calendar sync requires admin or cron authorization' })
  return false
}

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase()

  if (action === 'mint-time') {
    req.query = { ...(req.query || {}), mintTime: 'detect' }
    return etherscanHandler(req, res)
  }

  if (action === 'status') {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const supabase = createServiceClient()
    const status = await getCalendarStatus(supabase)
    return res.status(200).json(status)
  }

  if (action === 'submit') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return

    const limited = await rateLimit(`rl:calendar-submit:${user.id}`, 12, 60)
    if (!limited.allowed) return sendRateLimit(res, limited)

    const body = req.body || {}
    const isAdmin = isAdminUser(user)
    if (!body.name) return res.status(400).json({ ok: false, error: 'Project name is required' })
    if (!body.contract_address && !body.mint_url && !body.website_url && !body.x_url) {
      return res.status(400).json({ ok: false, error: 'Add a contract, mint page, website, or X link' })
    }

    const row = normalizeProject({
      ...body,
      status: isAdmin ? 'approved' : 'pending_review',
      source: isAdmin ? 'admin' : 'community',
      source_confidence: body.mint_date ? 'medium' : 'low',
      created_by: user.id,
      created_by_wallet: body.created_by_wallet || null,
      approved_by: isAdmin ? user.id : null,
      approved_at: isAdmin ? new Date().toISOString() : null,
      mint_date_source: body.mint_date ? 'community_submission' : null,
      mint_date_confidence: body.mint_date ? 'manual' : 'low',
      mint_time_confirmed: Boolean(body.mint_date),
      risk_score: body.contract_address ? 45 : 60,
      hidden_gem_score: body.contract_address ? 35 : 20,
    }, isAdmin ? 'admin' : 'community')

    row.created_by = user.id
    row.created_by_wallet = body.created_by_wallet || null
    row.approved_by = isAdmin ? user.id : null
    row.approved_at = isAdmin ? new Date().toISOString() : null

    const supabase = createServiceClient()
    const { data, error } = await supabase.from('calendar_projects').insert(row).select().single()
    if (error) return res.status(500).json({ ok: false, error: 'Could not submit calendar project' })
    return res.status(200).json({ ok: true, project: data })
  }

  if (action === 'moderate') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await getOptionalUser(req)
    if (!user || !isAdminUser(user)) return res.status(403).json({ ok: false, error: 'Admin access required' })

    const { projectId, status } = req.body || {}
    const allowed = new Set(['approved', 'live', 'ended', 'rejected', 'hidden'])
    if (!projectId || !allowed.has(status)) return res.status(400).json({ ok: false, error: 'Invalid moderation request' })

    const payload = {
      status,
      approved_by: status === 'approved' || status === 'live' ? user.id : null,
      approved_at: status === 'approved' || status === 'live' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('calendar_projects')
      .update(payload)
      .eq('id', projectId)
      .select()
      .single()
    if (error) return res.status(500).json({ ok: false, error: 'Could not update calendar project' })
    return res.status(200).json({ ok: true, project: data })
  }

  if (action === 'sync') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    if (!(await canRunSync(req, res))) return

    const limited = await rateLimit('rl:calendar-sync', 6, 60)
    if (!limited.allowed) return sendRateLimit(res, limited)

    const supabase = createServiceClient()
    const requestedSources = Array.isArray(req.body?.sources) ? req.body.sources : null
    const limit = Math.max(3, Math.min(20, Number(req.body?.limit || 12)))
    const summary = await runCalendarSync(supabase, {
      sources: requestedSources || undefined,
      limit,
    })
    return res.status(200).json(summary)
  }

  return res.status(404).json({ ok: false, error: 'Unknown calendar action' })
}
