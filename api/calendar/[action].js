import etherscanHandler from '../etherscan.js'
import { createServiceClient, getBearerToken, isAdminUser, createAnonClient, requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { runCalendarSync, getCalendarStatus } from '../../src/server/calendar/sync.js'
import { normalizeProject } from '../../src/server/calendar/normalize.js'
import { calendarQualityScore, isRawCalendarDiscovery, mintGuardEligible } from '../../src/lib/calendarQuality.js'

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
  'share_code',
]

const CALENDAR_EXTENDED_FIELDS = [
  'quality_score',
  'rating_avg',
  'rating_count',
  'share_code',
  'share_slug',
  'submitted_by_user_id',
  'submitted_by_wallet',
  'submitter_role',
  'community_name',
  'community_x_handle',
  'submitted_by_label',
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

function stripFields(row, fields) {
  const clean = { ...row }
  fields.forEach(field => delete clean[field])
  return clean
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

function calendarMintTypeToWlType(value) {
  const type = String(value || '').toLowerCase()
  if (type.includes('allow') || type.includes('white')) return 'WL'
  if (type.includes('free')) return 'FREE'
  return 'PUBLIC'
}

function calendarSourceType(project) {
  const value = `${project?.source || ''} ${project?.source_url || ''} ${project?.mint_url || ''} ${project?.website_url || ''}`.toLowerCase()
  if (value.includes('opensea')) return 'opensea'
  if (value.includes('twitter') || value.includes('x.com/')) return 'twitter'
  return 'website'
}

async function saveRatingWithAggregateFallback(supabase, projectId, numericRating) {
  const { data: project, error: loadError } = await supabase
    .from('calendar_projects')
    .select('rating_avg,rating_count')
    .eq('id', projectId)
    .single()
  if (loadError) {
    if (isWriteShapeError(loadError) || isCalendarSchemaError(loadError)) {
      return { ratingAvg: numericRating, ratingCount: 1, localOnly: true }
    }
    throw loadError
  }

  const currentCount = Number(project?.rating_count || 0)
  const currentAvg = Number(project?.rating_avg || 0)
  const nextCount = currentCount + 1
  const nextAvg = ((currentAvg * currentCount) + numericRating) / nextCount
  const { error: updateError } = await supabase
    .from('calendar_projects')
    .update({
      rating_avg: Number(nextAvg.toFixed(2)),
      rating_count: nextCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
  if (updateError) {
    if (isWriteShapeError(updateError) || isCalendarSchemaError(updateError)) {
      return { ratingAvg: Number(nextAvg.toFixed(2)), ratingCount: nextCount, localOnly: true }
    }
    throw updateError
  }
  return { ratingAvg: Number(nextAvg.toFixed(2)), ratingCount: nextCount, localOnly: true }
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
  })

  attempts.push({
    user_id: payload.user_id,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
    chain: payload.chain,
    contract_address: payload.contract_address,
  })

  attempts.push({
    user_id: payload.user_id,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
    chain: payload.chain,
  })

  attempts.push({
    user_id: payload.user_id,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
  })

  attempts.push({
    user_id: payload.user_id,
    name: payload.name,
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
      submitted_by_user_id: user.id,
      submitted_by_wallet: body.created_by_wallet || null,
      submitter_role: body.submitter_role || (isAdmin ? 'admin' : 'user'),
      community_name: body.community_name || null,
      community_x_handle: body.community_x_handle || null,
      submitted_by_label: body.submitted_by_label || body.community_name || body.community_x_handle || null,
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
    let { data, error } = await supabase.from('calendar_projects').insert(row).select().single()
    if (error && isWriteShapeError(error)) {
      const retry = await supabase.from('calendar_projects').insert(stripFields(row, CALENDAR_EXTENDED_FIELDS)).select().single()
      data = retry.data
      error = retry.error
    }
    if (error) return res.status(500).json({ ok: false, error: 'Could not submit calendar project' })
    return res.status(200).json({ ok: true, project: data })
  }

  if (action === 'rate') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return
    const { projectId, rating, review, walletAddress } = req.body || {}
    const numericRating = Number(rating)
    if (!projectId || !Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ ok: false, error: 'Choose a rating from 1 to 5' })
    }

    const supabase = createServiceClient()
    const payload = {
      project_id: projectId,
      user_id: user.id,
      wallet_address: walletAddress || null,
      rating: numericRating,
      review: review || null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase
      .from('calendar_project_ratings')
      .upsert(payload, { onConflict: 'project_id,user_id' })
    if (error) {
      if (isWriteShapeError(error) || isCalendarSchemaError(error)) {
        try {
          const fallback = await saveRatingWithAggregateFallback(supabase, projectId, numericRating)
          return res.status(200).json({ ok: true, ...fallback })
        } catch (fallbackError) {
          console.error('calendar rating fallback failed:', fallbackError)
        }
      }
      return res.status(200).json({ ok: true, ratingAvg: numericRating, ratingCount: 1, localOnly: true })
    }

    const { data: ratings } = await supabase
      .from('calendar_project_ratings')
      .select('rating')
      .eq('project_id', projectId)
    const count = ratings?.length || 0
    const avg = count ? ratings.reduce((sum, row) => sum + Number(row.rating || 0), 0) / count : 0
    await supabase
      .from('calendar_projects')
      .update({ rating_avg: Number(avg.toFixed(2)), rating_count: count, updated_at: new Date().toISOString() })
      .eq('id', projectId)

    return res.status(200).json({ ok: true, ratingAvg: Number(avg.toFixed(2)), ratingCount: count })
  }

  if (action === 'cleanup') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await getOptionalUser(req)
    if (!user || !isAdminUser(user)) return res.status(403).json({ ok: false, error: 'Admin access required' })

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('calendar_projects')
      .select('*')
      .in('status', ['approved', 'live', 'pending_review'])
      .limit(500)
    if (error) return res.status(500).json({ ok: false, error: 'Could not load calendar projects' })

    let reviewed = 0
    let downgraded = 0
    let scored = 0
    for (const project of data || []) {
      reviewed += 1
      const quality = calendarQualityScore(project)
      const nextStatus = isRawCalendarDiscovery(project) || quality < 50 ? 'pending_review' : project.status
      const payload = { quality_score: quality, updated_at: new Date().toISOString() }
      if (nextStatus !== project.status) {
        payload.status = nextStatus
        downgraded += 1
      }
      let update = await supabase.from('calendar_projects').update(payload).eq('id', project.id)
      if (update.error && isWriteShapeError(update.error)) {
        update = await supabase.from('calendar_projects').update(stripFields(payload, CALENDAR_EXTENDED_FIELDS)).eq('id', project.id)
      }
      if (!update.error) scored += 1
    }
    return res.status(200).json({ ok: true, reviewed, scored, downgraded })
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
    const chain = normalizeChain(project.chain)
    const eligible = mintGuardEligible(project)
    const payload = {
      user_id: user.id,
      name: mintGuardName(project),
      source_url: project.mint_url || project.source_url || project.website_url || null,
      source_type: calendarSourceType(project),
      calendar_project_id: project.id,
      share_code: project.share_code || null,
      chain,
      contract_address: project.contract_address || null,
      mint_date: project.mint_date || null,
      mint_price: project.mint_price || null,
      wl_type: calendarMintTypeToWlType(project.mint_type),
      mint_mode: 'confirm',
      automint_enabled: false,
      max_mint: 1,
      gas_limit: 200000,
      mint_time_source: project.mint_date_source || project.source || 'calendar',
      mint_time_confidence: project.mint_date_confidence || project.source_confidence || 'low',
      mint_time_confirmed: Boolean(project.mint_time_confirmed),
      mint_time_confirmed_at: project.mint_time_confirmed ? new Date().toISOString() : null,
      execution_status: 'queued',
      notes: eligible
        ? 'Added from Alpha Hub Calendar in Confirm Mode.'
        : 'Added from Alpha Hub Calendar as a needs-review project. Verify official links before Auto Beta.',
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
