import etherscanHandler from '../etherscan.js'
import { createServiceClient, getBearerToken, isAdminUser, createAnonClient, requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { runCalendarSync, getCalendarStatus } from '../../src/server/calendar/sync.js'
import { normalizeProject } from '../../src/server/calendar/normalize.js'
import { isRawCalendarDiscovery, mintGuardEligible } from '../../src/lib/calendarQuality.js'

const OPTIONAL_MINTGUARD_FIELDS = [
  'calendar_project_id',
  'automint_enabled',
  'max_mint_price',
  'max_gas_fee',
  'max_total_spend',
  'mint_time_source',
  'mint_time_confidence',
  'mint_time_confirmed',
  'mint_time_confirmed_at',
  'execution_status',
  'notes',
]

function calendarSchemaMissingResponse() {
  return {
    ok: false,
    schemaMissing: true,
    error: 'Calendar database table is not installed yet. Apply the Calendar SQL migration, then run sync.',
    message: 'Calendar database table is not installed yet. Apply the Calendar SQL migration, then run sync.',
  }
}

function isCalendarSchemaError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  const code = String(error?.code || '')
  return (
    code === '42P01' ||
    message.includes('calendar_projects') ||
    message.includes('calendar_sync_runs') ||
    message.includes('schema cache') ||
    message.includes('relation') ||
    message.includes('does not exist')
  )
}

function isWriteShapeError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    message.includes('schema cache') ||
    message.includes('column') ||
    message.includes('check constraint') ||
    message.includes('violates') ||
    message.includes('null value')
  )
}

function normalizeChain(chain) {
  const value = String(chain || 'eth').toLowerCase()
  if (value.includes('base')) return 'base'
  if (value.includes('bnb') || value.includes('bsc')) return 'bnb'
  return 'eth'
}

function shortAddress(address) {
  if (!address) return ''
  return `${String(address).slice(0, 6)}...${String(address).slice(-4)}`
}

function mintGuardName(project) {
  const name = String(project?.name || '').trim()
  if (name && !isRawCalendarDiscovery({ ...project, name })) return name
  if (project?.contract_address) return `NFT Contract ${shortAddress(project.contract_address)}`
  return 'Calendar Mint Project'
}

async function insertMintGuardProject(supabase, payload) {
  const attempts = []
  attempts.push(payload)

  const withoutOptional = { ...payload }
  OPTIONAL_MINTGUARD_FIELDS.forEach(field => delete withoutOptional[field])
  attempts.push(withoutOptional)

  attempts.push({
    user_id: payload.user_id,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
    chain: payload.chain,
    contract_address: payload.contract_address,
    mint_date: payload.mint_date,
    mint_price: payload.mint_price,
    wl_type: payload.wl_type,
    status: payload.status,
  })

  attempts.push({
    user_id: payload.user_id,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
    chain: payload.chain,
    status: payload.status,
  })

  let lastError = null
  for (const attempt of attempts) {
    const clean = Object.fromEntries(Object.entries(attempt).filter(([, value]) => value !== undefined))
    const { data, error } = await supabase.from('wl_projects').insert(clean).select().single()
    if (!error) return data
    lastError = error
    if (!isWriteShapeError(error)) break
  }

  throw lastError || new Error('Could not add project to MintGuard')
}

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
    try {
      const status = await getCalendarStatus(supabase)
      return res.status(200).json(status)
    } catch (error) {
      if (isCalendarSchemaError(error)) return res.status(200).json(calendarSchemaMissingResponse())
      return res.status(200).json({ ok: false, error: 'Calendar status is temporarily unavailable' })
    }
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

  if (action === 'add-to-mintguard') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return

    const { projectId } = req.body || {}
    if (!projectId) return res.status(400).json({ ok: false, error: 'Project is required' })

    const supabase = createServiceClient()
    const { data: project, error: projectError } = await supabase
      .from('calendar_projects')
      .select('*')
      .eq('id', projectId)
      .single()

    if (projectError || !project) return res.status(404).json({ ok: false, error: 'Calendar project not found' })
    if (!['approved', 'live', 'ended', 'pending_review'].includes(project.status)) {
      return res.status(400).json({ ok: false, error: 'This project is not available for MintGuard' })
    }
    if (!mintGuardEligible(project)) {
      return res.status(400).json({
        ok: false,
        error: 'This project needs real metadata before it can be added to MintGuard',
      })
    }

    const chain = normalizeChain(project.chain)
    const payload = {
      user_id: user.id,
      name: mintGuardName(project),
      source_url: project.mint_url || project.source_url || project.website_url || null,
      source_type: project.source === 'onchain' ? 'contract' : 'calendar',
      calendar_project_id: project.id,
      chain,
      contract_address: project.contract_address || null,
      mint_date: project.mint_date || null,
      mint_price: project.mint_price || null,
      wl_type: String(project.mint_type || 'PUBLIC').toUpperCase(),
      mint_mode: 'confirm',
      automint_enabled: false,
      max_mint: 1,
      gas_limit: 200000,
      mint_time_source: project.mint_date_source || project.source || 'calendar',
      mint_time_confidence: project.mint_date_confidence || project.source_confidence || 'low',
      mint_time_confirmed: Boolean(project.mint_time_confirmed),
      mint_time_confirmed_at: project.mint_time_confirmed ? new Date().toISOString() : null,
      execution_status: 'queued',
      notes: project.source === 'onchain'
        ? 'Added from Alpha Hub Calendar onchain discovery. Verify official links before Auto Beta.'
        : 'Added from Alpha Hub Calendar in Confirm Mode.',
      status: project.status === 'live' ? 'live' : 'upcoming',
    }

    try {
      const row = await insertMintGuardProject(supabase, payload)
      return res.status(200).json({ ok: true, project: row })
    } catch (error) {
      console.error('calendar add-to-mintguard failed:', error)
      return res.status(500).json({ ok: false, error: 'Could not add this project to MintGuard' })
    }
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
    try {
      const status = await getCalendarStatus(supabase)
      if (status?.schemaMissing) return res.status(200).json(calendarSchemaMissingResponse())
      const summary = await runCalendarSync(supabase, {
        sources: requestedSources || undefined,
        limit,
      })
      return res.status(200).json(summary)
    } catch (error) {
      if (isCalendarSchemaError(error)) return res.status(200).json(calendarSchemaMissingResponse())
      return res.status(200).json({ ok: false, error: 'Calendar sync is temporarily unavailable' })
    }
  }

  return res.status(404).json({ ok: false, error: 'Unknown calendar action' })
}
