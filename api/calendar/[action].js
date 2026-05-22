import etherscanHandler from '../etherscan.js'
import { createServiceClient, getBearerToken, isAdminUser, createAnonClient, requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { runCalendarSync, getCalendarStatus } from '../../src/server/calendar/sync.js'
import { normalizeProject, shareCode as makeShareCode, shareSlug as makeShareSlug } from '../../src/server/calendar/normalize.js'
import { calendarQualityScore, isRawCalendarDiscovery, mintGuardEligible } from '../../src/lib/calendarQuality.js'
import { detectProject } from '../_lib/project-intelligence.js'
import { handleMintAction } from '../_lib/mint-engine.js'
import { handleVaultAction } from '../_lib/vault-engine.js'

const OPTIONAL_MINTGUARD_FIELDS = [
  'wallet_address',
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
  'image_url',
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
  'mint_status',
  'mint_end_date',
  'price_value',
  'price_currency',
  'price_label',
  'price_note',
  'price_confidence',
  'stage_prices',
  'mint_schedule',
  'source_metadata',
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
    message.includes('calendar_project_ratings') ||
    message.includes('calendar_project_watchers') ||
    message.includes('calendar_saved_projects') ||
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
    message.includes('relation') ||
    message.includes('does not exist') ||
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

function primaryWalletForUser(user) {
  const candidates = [
    user?.user_metadata?.wallet_address,
    user?.user_metadata?.walletAddress,
    user?.user_metadata?.address,
    user?.user_metadata?.custom_claims?.address,
    user?.user_metadata?.sub,
    user?.app_metadata?.wallet_address,
    user?.app_metadata?.walletAddress,
    user?.app_metadata?.address,
    user?.app_metadata?.custom_claims?.address,
    user?.app_metadata?.sub,
    ...(user?.identities || []).flatMap(identity => [
      identity?.identity_data?.wallet_address,
      identity?.identity_data?.walletAddress,
      identity?.identity_data?.address,
      identity?.identity_data?.custom_claims?.address,
      identity?.identity_data?.sub,
    ]),
  ].filter(Boolean)

  return candidates
    .map(value => String(value).toLowerCase())
    .map(value => value.startsWith('web3:ethereum:') ? value.replace('web3:ethereum:', '') : value)
    .find(value => /^0x[a-f0-9]{40}$/.test(value)) || null
}

function walletCandidatesForUser(user) {
  const primary = primaryWalletForUser(user)
  return primary ? [primary] : []
}

function rowBelongsToUser(row, user) {
  if (!row || !user) return false
  if (row.user_id && row.user_id === user.id) return true
  const wallets = walletCandidatesForUser(user)
  const rowWallet = String(row.wallet_address || row.owner || row.wallet || '').toLowerCase()
  return Boolean(rowWallet && wallets.includes(rowWallet))
}

function normalizeChain(chain) {
  const value = String(chain || 'eth').toLowerCase()
  if (value.includes('base')) return 'base'
  if (value.includes('ape')) return 'apechain'
  if (value.includes('sol')) return 'solana'
  if (value.includes('bnb') || value.includes('bsc')) return 'bnb'
  return 'eth'
}

function explorerAddressUrl(chain, address) {
  if (!address) return null
  const normalized = normalizeChain(chain)
  if (normalized === 'base') return `https://basescan.org/address/${address}`
  if (normalized === 'apechain') return `https://apescan.io/address/${address}`
  if (normalized === 'bnb') return `https://bscscan.com/address/${address}`
  if (normalized === 'solana') return `https://solscan.io/account/${address}`
  return `https://etherscan.io/address/${address}`
}

function projectSourceUrl(project) {
  return (
    project.mint_url ||
    project.source_url ||
    project.website_url ||
    project.x_url ||
    explorerAddressUrl(project.chain, project.contract_address) ||
    'https://poseidonph.com/calendar'
  )
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
  if (type.includes('free')) return 'FREE'
  if (type.includes('fcfs')) return 'FCFS'
  return 'PUBLIC'
}

function calendarSourceType(project) {
  const value = `${project?.source || ''} ${project?.source_url || ''} ${project?.mint_url || ''} ${project?.website_url || ''}`.toLowerCase()
  if (value.includes('opensea')) return 'opensea'
  if (value.includes('twitter') || value.includes('x.com/')) return 'twitter'
  return 'website'
}

function codeSuffix(projectId) {
  return String(projectId || Math.random().toString(36).slice(2, 8)).replace(/-/g, '').slice(0, 4).toUpperCase()
}

async function ensureShareFields(supabase, project) {
  if (project?.share_code && project?.share_slug) return project
  const baseCode = makeShareCode(project?.name || project?.slug || 'alpha', project?.contract_address)
  const baseSlug = makeShareSlug(project?.name || project?.slug || baseCode)
  const patch = {
    share_code: project?.share_code || `${baseCode}-${codeSuffix(project?.id)}`.slice(0, 24),
    share_slug: project?.share_slug || `${baseSlug}-${codeSuffix(project?.id).toLowerCase()}`.slice(0, 80),
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('calendar_projects')
    .update(patch)
    .eq('id', project.id)
    .select()
    .single()
  if (error && !isWriteShapeError(error)) throw error
  return data || { ...project, ...patch }
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

async function updateRatingAggregate(supabase, projectId) {
  const { data: ratings, error: ratingsError } = await supabase
    .from('calendar_project_ratings')
    .select('rating')
    .eq('project_id', projectId)
  if (ratingsError) throw ratingsError
  const count = ratings?.length || 0
  const avg = count ? ratings.reduce((sum, row) => sum + Number(row.rating || 0), 0) / count : 0
  const ratingAvg = Number(avg.toFixed(2))
  const { error: updateError } = await supabase
    .from('calendar_projects')
    .update({ rating_avg: ratingAvg, rating_count: count, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (updateError && !isWriteShapeError(updateError)) throw updateError
  return { ratingAvg, ratingCount: count }
}

async function findExistingMintGuardProject(supabase, userId, project, payload) {
  const filters = []
  if (project?.id) filters.push(`calendar_project_id.eq.${project.id}`)
  if (project?.contract_address) filters.push(`contract_address.eq.${project.contract_address}`)
  if (payload?.source_url) filters.push(`source_url.eq.${payload.source_url}`)
  if (!filters.length) return null

  let query = supabase
    .from('wl_projects')
    .select('*')
    .eq('user_id', userId)
    .or(filters.join(','))
    .limit(1)

  let { data, error } = await query
  if (error && isWriteShapeError(error)) {
    const fallbackFilters = []
    if (project?.contract_address) fallbackFilters.push(`contract_address.eq.${project.contract_address}`)
    if (payload?.source_url) fallbackFilters.push(`source_url.eq.${payload.source_url}`)
    if (!fallbackFilters.length) return null
    const retry = await supabase
      .from('wl_projects')
      .select('*')
      .eq('user_id', userId)
      .or(fallbackFilters.join(','))
      .limit(1)
    data = retry.data
    error = retry.error
  }
  if (error && payload?.wallet_address) {
    const fallbackFilters = []
    if (project?.contract_address) fallbackFilters.push(`contract_address.eq.${project.contract_address}`)
    if (payload?.source_url) fallbackFilters.push(`source_url.eq.${payload.source_url}`)
    if (!fallbackFilters.length) return null
    const retry = await supabase
      .from('wl_projects')
      .select('*')
      .eq('wallet_address', payload.wallet_address)
      .or(fallbackFilters.join(','))
      .limit(1)
    data = retry.data
    error = retry.error
  }
  if (error) return null
  return data?.[0] || null
}

async function insertMintGuardProject(supabase, payload) {
  const attempts = []
  attempts.push(payload)

  const withoutOptional = { ...payload }
  OPTIONAL_MINTGUARD_FIELDS.forEach(field => delete withoutOptional[field])
  attempts.push(withoutOptional)

  const legacySafe = {
    ...withoutOptional,
    source_type: 'website',
    wl_type: 'UNKNOWN',
    status: 'upcoming',
  }
  attempts.push(legacySafe)

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: 'website',
    chain: payload.chain,
    contract_address: payload.contract_address,
    mint_date: payload.mint_date,
    mint_price: payload.mint_price,
    wl_type: 'UNKNOWN',
    status: 'upcoming',
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
    chain: payload.chain,
    contract_address: payload.contract_address,
    mint_date: payload.mint_date,
    mint_price: payload.mint_price,
    wl_type: payload.wl_type,
    status: payload.status,
    image_url: payload.image_url,
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: payload.source_type,
    chain: payload.chain,
    status: payload.status,
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: 'website',
    chain: payload.chain,
    contract_address: payload.contract_address,
    mint_date: payload.mint_date,
    mint_price: payload.mint_price,
    wl_type: 'UNKNOWN',
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: 'website',
    chain: payload.chain,
    contract_address: payload.contract_address,
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: 'website',
    chain: payload.chain,
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: 'website',
    wl_type: 'UNKNOWN',
    status: 'upcoming',
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
    source_url: payload.source_url,
    source_type: 'website',
  })

  attempts.push({
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    name: payload.name,
  })

  if (payload.wallet_address) {
    attempts.push({
      wallet_address: payload.wallet_address,
      name: payload.name,
      source_url: payload.source_url,
      source_type: 'website',
      chain: payload.chain,
      contract_address: payload.contract_address,
      mint_date: payload.mint_date,
      mint_price: payload.mint_price,
      wl_type: 'UNKNOWN',
      status: 'upcoming',
    })
    attempts.push({
      wallet_address: payload.wallet_address,
      name: payload.name,
      source_url: payload.source_url,
      source_type: 'website',
      chain: payload.chain,
    })
    attempts.push({
      wallet_address: payload.wallet_address,
      name: payload.name,
      source_url: payload.source_url,
      source_type: 'website',
    })
  }

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

async function upsertProjectRelation(supabase, table, payload) {
  const { data, error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: 'project_id,user_id' })
    .select()
    .single()
  if (!error) return data
  if (isCalendarSchemaError(error) || isWriteShapeError(error)) {
    return { ...payload, localOnly: true }
  }
  throw error
}

async function safeDeleteProjectChildren(supabase, projectId, userId) {
  const now = new Date().toISOString()

  // Null out wl_project_id in mint_intents (FK blocker if present)
  const intentAttempts = [
    { wl_project_id: null, strike_enabled: false, strike_status: 'cancelled', status: 'cancelled', strike_error: 'MintGuard project removed', updated_at: now },
    { wl_project_id: null, status: 'cancelled', updated_at: now },
    { wl_project_id: null, updated_at: now },
    { wl_project_id: null },
  ]

  let lastError = null
  for (const payload of intentAttempts) {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
    const { error } = await supabase
      .from('mint_intents')
      .update(clean)
      .eq('wl_project_id', projectId)
      .eq('user_id', userId)
    if (!error) { lastError = null; break }
    lastError = error
    if (!isWriteShapeError(error)) break
  }
  if (lastError && !isWriteShapeError(lastError)) {
    console.warn('MintGuard intent cleanup warning:', lastError)
  }

  // Null out project_id in mint_log (FK blocker if present — table may or may not have FK)
  try {
    await supabase.from('mint_log').update({ project_id: null }).eq('project_id', projectId).eq('user_id', userId)
  } catch (_) {}
}

async function softArchiveMintGuardProject(supabase, projectId, user, project = null) {
  const payloads = [
    { status: 'archived', deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { status: 'cancelled', deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { status: 'cancelled', updated_at: new Date().toISOString() },
  ]
  let lastError = null
  for (const payload of payloads) {
    let query = supabase.from('wl_projects').update(payload).eq('id', projectId)
    if (!isAdminUser(user) && project?.user_id) query = query.eq('user_id', project.user_id)
    const { data, error } = await query.select().maybeSingle()
    if (!error) return data || { id: projectId, ...payload }
    lastError = error
    if (!isWriteShapeError(error)) break
  }
  throw lastError || new Error('Archive failed')
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

  res.status(403).json({ ok: false, error: 'Alpha Radar sync requires admin or cron authorization' })
  return false
}

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase()

  if (action === 'detect-project') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return
    const limited = await rateLimit(`rl:intel-detect:${user.id}`, 30, 60)
    if (!limited.allowed) return sendRateLimit(res, limited)
    try {
      const result = await detectProject(req.body || {})
      return res.status(200).json(result)
    } catch (error) {
      console.error('detect-project failed:', error)
      return res.status(200).json({ ok: false, error: 'Could not detect this project yet.' })
    }
  }

  if (action.startsWith('mint-')) {
    return handleMintAction(req, res, action.replace(/^mint-/, ''))
  }

  if (action.startsWith('vault-')) {
    return handleVaultAction(req, res, action.replace(/^vault-/, ''))
  }

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
      return res.status(200).json({ ok: false, error: 'Alpha Radar status is temporarily unavailable' })
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
      status: isAdmin
        ? (body.mint_status === 'live_now' ? 'live' : 'approved')
        : 'pending_review',
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
    if (error) return res.status(500).json({ ok: false, error: 'Could not submit alpha' })
    data = await ensureShareFields(supabase, data)
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

    const aggregate = await updateRatingAggregate(supabase, projectId)
    return res.status(200).json({ ok: true, ...aggregate })
  }

  if (action === 'watch' || action === 'save') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return
    const { projectId, walletAddress } = req.body || {}
    if (!projectId) return res.status(400).json({ ok: false, error: 'Project is required' })
    const supabase = createServiceClient()
    const table = action === 'watch' ? 'calendar_project_watchers' : 'calendar_saved_projects'
    try {
      const row = await upsertProjectRelation(supabase, table, {
        project_id: projectId,
        user_id: user.id,
        wallet_address: walletAddress || null,
        created_at: new Date().toISOString(),
      })
      return res.status(200).json({ ok: true, [action]: row })
    } catch (error) {
      console.error(`calendar ${action} failed:`, error)
      return res.status(500).json({ ok: false, error: `Could not ${action} this project` })
    }
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

    const { projectId, calendarProjectId } = req.body || {}
    const targetProjectId = projectId || calendarProjectId
    if (!targetProjectId) return res.status(400).json({ ok: false, error: 'Project is required' })

    const supabase = createServiceClient()
    const { data: project, error: projectError } = await supabase
      .from('calendar_projects')
      .select('*')
      .eq('id', targetProjectId)
      .single()

    if (projectError || !project) return res.status(404).json({ ok: false, error: 'Alpha Radar project not found' })
    if (!['approved', 'live', 'ended', 'pending_review'].includes(project.status)) {
      return res.status(400).json({ ok: false, error: 'This project is not available for MintGuard' })
    }
    const chain = normalizeChain(project.chain)
    const eligible = mintGuardEligible(project)
    const walletAddress = primaryWalletForUser(user)
    const payload = {
      user_id: user.id,
      wallet_address: walletAddress,
      name: mintGuardName(project),
      source_url: projectSourceUrl(project),
      source_type: calendarSourceType(project),
      calendar_project_id: project.id,
      share_code: project.share_code || null,
      image_url: project.image_url || null,
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
        ? 'Added from Alpha Radar in Fast Mint mode.'
        : 'Added from Alpha Radar as a needs-review project. Verify official links before Strike Mode.',
      status: project.status === 'live' || project.mint_status === 'live_now' ? 'live' : 'upcoming',
    }

    try {
      const existing = await findExistingMintGuardProject(supabase, user.id, project, payload)
      if (existing) {
        await upsertProjectRelation(supabase, 'calendar_saved_projects', {
          project_id: project.id,
          user_id: user.id,
          wallet_address: null,
          created_at: new Date().toISOString(),
        }).catch(() => null)
        return res.status(200).json({ ok: true, duplicate: true, project: existing })
      }
      const row = await insertMintGuardProject(supabase, payload)
      await upsertProjectRelation(supabase, 'calendar_saved_projects', {
        project_id: project.id,
        user_id: user.id,
        wallet_address: null,
        created_at: new Date().toISOString(),
      }).catch(() => null)
      return res.status(200).json({ ok: true, project: row })
    } catch (error) {
      console.error('calendar add-to-mintguard failed:', error)
      if (String(error?.code || '') === '23505') {
        const existing = await findExistingMintGuardProject(supabase, user.id, project, payload)
        if (existing) return res.status(200).json({ ok: true, duplicate: true, project: existing })
      }
      return res.status(500).json({ ok: false, error: 'Could not add this project to MintGuard.' })
    }
  }

  if (action === 'copy-mint') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return

    const supabase = createServiceClient()
    const body = req.body || {}
    const activity = body.activity || body
    const contract = activity.contract_address || activity.contractAddress || activity.to || activity.token_address || null
    const txHash = activity.tx_hash || activity.txHash || null
    const chain = normalizeChain(activity.chain || body.chain || 'eth')
    const sourceUrl = txHash
      ? `https://${chain === 'base' ? 'basescan.org' : chain === 'apechain' ? 'apescan.io' : 'etherscan.io'}/tx/${txHash}`
      : explorerAddressUrl(chain, contract) || 'https://poseidonph.com/whaleradar'
    const name = activity.contract_name ||
      activity.project_name ||
      activity.name ||
      (contract ? `Needs Review Mint ${shortAddress(contract)}` : 'Needs Review Whale Mint')

    const pseudoProject = {
      id: null,
      contract_address: contract,
      source_url: sourceUrl,
    }

    const payload = {
      user_id: user.id,
      name,
      source_url: sourceUrl,
      source_type: 'website',
      chain,
      contract_address: contract,
      mint_date: activity.timestamp || activity.block_timestamp || new Date().toISOString(),
      mint_price: activity.value_eth ? String(activity.value_eth) : null,
      wl_type: 'PUBLIC',
      mint_mode: 'confirm',
      automint_enabled: false,
      max_mint: 1,
      gas_limit: 200000,
      mint_time_source: 'whale_copy',
      mint_time_confidence: 'low',
      mint_time_confirmed: false,
      execution_status: 'queued',
      notes: `Copied from whale activity${txHash ? ` (${txHash})` : ''}. Review metadata before Fast or Strike Mint.`,
      status: 'live',
    }

    try {
      const existing = await findExistingMintGuardProject(supabase, user.id, pseudoProject, payload)
      if (existing) return res.status(200).json({ ok: true, duplicate: true, project: existing })
      const row = await insertMintGuardProject(supabase, payload)
      return res.status(200).json({ ok: true, project: row })
    } catch (error) {
      console.error('calendar copy-mint failed:', error)
      return res.status(500).json({ ok: false, error: 'Could not copy this mint. Please try again.' })
    }
  }

  if (action === 'save-mintguard') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return

    const d = req.body || {}
    if (!d.name?.trim()) return res.status(400).json({ ok: false, error: 'Project name is required' })

    const VALID_WL_TYPES = ['UNKNOWN', 'GTD', 'FCFS', 'PUBLIC', 'RAFFLE', 'FREE', 'PAID', 'ALLOWLIST', 'WL']
    const VALID_SOURCE_TYPES = ['website', 'url', 'twitter', 'x', 'opensea', 'calendar', 'contract', 'whale_copy', 'alchemy', 'zora', 'community', 'admin']
    const supabase = createServiceClient()
    try {
      const row = await insertMintGuardProject(supabase, {
        user_id: user.id,
        name: d.name.trim(),
        source_url: d.source_url || null,
        source_type: VALID_SOURCE_TYPES.includes(d.source_type) ? d.source_type : 'website',
        chain: d.chain || 'eth',
        contract_address: d.contract_address?.trim() || null,
        mint_date: d.mint_date || null,
        mint_price: d.mint_price || null,
        wl_type: VALID_WL_TYPES.includes(d.wl_type) ? d.wl_type : 'UNKNOWN',
        mint_mode: d.mint_mode || 'confirm',
        automint_enabled: Boolean(d.automint_enabled),
        max_mint: parseInt(d.max_mint) || 1,
        gas_limit: parseInt(d.gas_limit) || 200000,
        max_mint_price: d.max_mint_price || null,
        max_gas_fee: d.max_gas_fee || null,
        max_total_spend: d.max_total_spend || null,
        mint_time_confirmed: Boolean(d.mint_date),
        execution_status: 'queued',
        notes: d.notes || null,
        status: d.mint_status === 'live_now' ? 'live' : d.mint_status === 'ended' ? 'missed' : 'upcoming',
      })
      console.log('MintGuard project saved', { userId: user.id, name: d.name, chain: d.chain })
      return res.status(200).json({ ok: true, project: row })
    } catch (error) {
      console.error('save-mintguard failed:', {
        userId: user.id,
        name: d.name,
        chain: d.chain,
        code: error?.code,
        message: error?.message,
        details: error?.details,
        hint: error?.hint,
      })
      return res.status(500).json({ ok: false, error: error?.message || 'Could not save this project. Please try again.' })
    }
  }

  if (action === 'delete-mintguard') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return

    const projectId = req.body?.projectId || req.body?.id || req.body?.wlProjectId
    if (!projectId) return res.status(400).json({ ok: false, error: 'Project id is required' })

    const supabase = createServiceClient()
    try {
      const { data: project, error: loadError } = await supabase
        .from('wl_projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle()

      if (loadError) throw loadError
      if (!project) return res.status(404).json({ ok: false, error: 'MintGuard project not found' })
      if (!isAdminUser(user) && !rowBelongsToUser(project, user)) {
        return res.status(403).json({ ok: false, error: 'You can only delete your own MintGuard projects' })
      }

      await safeDeleteProjectChildren(supabase, projectId, project.user_id || user.id)

      let deleteQuery = supabase.from('wl_projects').delete().eq('id', projectId)
      if (!isAdminUser(user) && project.user_id) deleteQuery = deleteQuery.eq('user_id', project.user_id)
      const deleted = await deleteQuery.select().maybeSingle()
      if (!deleted.error) {
        console.log('MintGuard project deleted', { projectId, userId: user.id, mode: 'hard' })
        return res.status(200).json({ ok: true, deleted: true, mode: 'hard', project: deleted.data || project })
      }

      console.warn('MintGuard hard delete failed, trying archive', {
        projectId,
        userId: user.id,
        code: deleted.error?.code,
        message: deleted.error?.message,
      })

      const archived = await softArchiveMintGuardProject(supabase, projectId, user, project)
      console.log('MintGuard project archived', { projectId, userId: user.id, mode: 'archive' })
      return res.status(200).json({ ok: true, deleted: true, mode: 'archive', project: archived || project })
    } catch (error) {
      console.error('MintGuard delete failed:', {
        projectId,
        userId: user?.id,
        code: error?.code,
        message: error?.message,
        details: error?.details,
      })
      return res.status(500).json({ ok: false, error: 'Could not delete this project. Please try again.' })
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
    if (error) return res.status(500).json({ ok: false, error: 'Could not update Alpha Radar project' })
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
      return res.status(200).json({ ok: false, error: 'Alpha Radar sync is temporarily unavailable' })
    }
  }

  if (action.startsWith('capture-')) {
    return handleCaptureAction(req, res, action.replace(/^capture-/, ''))
  }

  return res.status(404).json({ ok: false, error: 'Unknown calendar action' })
}

// ── Mint Capture Mode ─────────────────────────────────────────────────────────

const CAPTURE_TABLE = 'mint_capture_profiles'
const CAPTURE_BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

function captureSchemaError(err) {
  const m = String(err?.message || '').toLowerCase()
  return String(err?.code || '') === '42P01' || m.includes(CAPTURE_TABLE) || m.includes('schema cache') || m.includes('does not exist')
}

function normCaptureAddr(v) {
  const s = String(v || '').trim().toLowerCase()
  return /^0x[a-f0-9]+$/.test(s) ? s : null
}

function normCaptureChain(v) {
  const s = String(v || 'eth').toLowerCase()
  if (s.includes('base')) return 'base'
  if (s.includes('ape')) return 'apechain'
  if (s.includes('bnb') || s.includes('bsc')) return 'bnb'
  return 'eth'
}

const CAPTURE_INJECT = `<script>
;(function(){if(window.__AH_CAPTURE_ACTIVE)return;window.__AH_CAPTURE_ACTIVE=true;var P=(function(){try{return window.parent!==window?window.parent:null}catch(e){return null}})();function badge(){var s=document.createElement('style');s.textContent='#__ahb{position:fixed;top:10px;right:10px;z-index:2147483647;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font:700 11px/1 monospace;padding:5px 12px;border-radius:99px;box-shadow:0 2px 16px rgba(0,0,0,.45);pointer-events:none;letter-spacing:.04em}#__ahn{position:fixed;top:44px;right:10px;z-index:2147483647;background:#10b981;color:#fff;font:600 11px/1 monospace;padding:6px 13px;border-radius:8px;box-shadow:0 2px 14px rgba(0,0,0,.4);pointer-events:none;transition:opacity .3s}';var b=document.createElement('div');b.id='__ahb';b.textContent='⚡ CAPTURE MODE';var a=function(){document.body.appendChild(s);document.body.appendChild(b)};if(document.body)a();else document.addEventListener('DOMContentLoaded',a)}function notify(){var el=document.getElementById('__ahn');if(el){el.style.opacity='1';return}el=document.createElement('div');el.id='__ahn';el.textContent='✓ Transaction captured';document.body&&document.body.appendChild(el);setTimeout(function(){el.style.opacity='0'},2200);setTimeout(function(){el.remove()},2700)}function patch(eth){if(!eth||eth.__ahp)return eth;var orig=eth.request.bind(eth);eth.request=async function(a){var m=a&&a.method||'';if(m==='eth_sendTransaction'||m==='wallet_sendTransaction'){var tx=(a.params||[])[0];if(tx&&P){try{P.postMessage({__type:'AH_CAPTURE_TX',tx:tx},'*')}catch(e){}}notify()}return orig(a)};eth.__ahp=true;return eth}badge();if(window.ethereum)patch(window.ethereum);try{var d=Object.getOwnPropertyDescriptor(window,'ethereum');if(!d||d.configurable!==false){var _e=window.ethereum;Object.defineProperty(window,'ethereum',{get:function(){return _e},set:function(v){_e=patch(v)},configurable:true})}}catch(e){}window.addEventListener('ethereum#initialized',function(){if(window.ethereum)patch(window.ethereum)},{once:true});window.addEventListener('eip6963:announceProvider',function(e){if(e.detail&&e.detail.provider)patch(e.detail.provider)});try{window.dispatchEvent(new Event('eip6963:requestProvider'))}catch(e){}})();
</script>`

async function handleCaptureAction(req, res, subAction) {
  // ── proxy ────────────────────────────────────────────────────────────────────
  if (subAction === 'proxy') {
    if (req.method !== 'GET') return res.status(405).end('Method Not Allowed')
    const token = req.query.token || getBearerToken(req)
    if (!token) return res.status(401).json({ error: 'Authentication required' })
    const supabase = createAnonClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired session' })
    const rawUrl = req.query.url
    if (!rawUrl) return res.status(400).end('Missing url parameter')
    let parsed
    try { parsed = new URL(rawUrl) } catch { return res.status(400).end('Invalid URL') }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).end('Only HTTP/S allowed')
    if (CAPTURE_BLOCKED_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.internal')) return res.status(400).end('URL not allowed')
    let fetchRes
    try {
      const controller = new AbortController()
      const tid = setTimeout(() => controller.abort(), 12000)
      fetchRes = await fetch(rawUrl, {
        signal: controller.signal, redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache' },
      })
      clearTimeout(tid)
    } catch (err) {
      return res.status(502).json({ error: 'Could not reach mint page', detail: err.message })
    }
    const ct = fetchRes.headers.get('content-type') || ''
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return res.status(415).json({ error: 'Not an HTML page' })
    let html
    try { html = await fetchRes.text() } catch (err) { return res.status(502).json({ error: 'Failed to read page body' }) }
    const origin = parsed.origin
    const baseTag = html.includes('<base ') ? '' : `<base href="${origin}/">`
    const injection = CAPTURE_INJECT + baseTag
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, m => `${m}${injection}`)
    else html = injection + html
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', "default-src * blob: data: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'")
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(html)
  }

  // All other capture actions require auth via Authorization header
  const user = await requireUser(req, res)
  if (!user) return
  const supabase = createAnonClient()

  // ── save ─────────────────────────────────────────────────────────────────────
  if (subAction === 'save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' })
    const body = req.body || {}
    const contractAddress = normCaptureAddr(body.contractAddress || body.contract_address)
    if (!contractAddress) return res.status(400).json({ error: 'contractAddress required' })
    const chain = normCaptureChain(body.chain)
    const toAddress = normCaptureAddr(body.toAddress || body.to_address || body.tx?.to)
    const calldata = String(body.calldata || body.tx?.data || '').toLowerCase() || null
    const selector = calldata?.slice(0, 10) || null
    const gasLimit = body.tx?.gas ? Number(body.tx.gas) : null
    const profile = {
      user_id: user.id, project_id: body.projectId || null, contract_address: contractAddress, chain,
      to_address: toAddress, calldata, selector, value_wei: String(body.tx?.value || '0'), gas_limit: gasLimit,
      mint_function: body.mintFunction || null, protocol: body.protocol || 'custom',
      router_address: body.routerAddress || toAddress, proof_required: Boolean(body.proofRequired ?? false),
      proof_shape: body.proofShape || 'none', multicall: false, gas_min: gasLimit, gas_max: gasLimit, gas_avg: gasLimit,
      sample_count: 1, verified: false, shared: false, source: body.source || 'capture', captured_at: new Date().toISOString(),
    }
    try {
      const { data: existing } = await supabase.from(CAPTURE_TABLE).select('id,sample_count,gas_avg').eq('contract_address', contractAddress).eq('chain', chain).eq('user_id', user.id).eq('selector', selector).maybeSingle()
      if (existing) {
        const n = (existing.sample_count || 0) + 1
        const gAvg = existing.gas_avg && gasLimit ? Math.round(((existing.gas_avg * (n - 1)) + gasLimit) / n) : gasLimit || existing.gas_avg
        const { data, error } = await supabase.from(CAPTURE_TABLE).update({ ...profile, sample_count: n, gas_avg: gAvg, updated_at: new Date().toISOString() }).eq('id', existing.id).select().single()
        if (error) throw error
        return res.status(200).json({ ok: true, profile: data, merged: true })
      }
      const { data, error } = await supabase.from(CAPTURE_TABLE).insert(profile).select().single()
      if (error) throw error
      return res.status(200).json({ ok: true, profile: data, merged: false })
    } catch (err) {
      if (captureSchemaError(err)) return res.status(200).json({ ok: true, profile, merged: false, tableNotReady: true })
      return res.status(500).json({ error: 'Failed to save profile' })
    }
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  if (subAction === 'list') {
    const q = req.method === 'GET' ? req.query : (req.body || {})
    const contractAddress = normCaptureAddr(q.contractAddress || q.contract_address)
    const chain = q.chain ? normCaptureChain(q.chain) : null
    try {
      let query = supabase.from(CAPTURE_TABLE).select('id,contract_address,chain,selector,mint_function,protocol,router_address,proof_required,proof_shape,gas_avg,gas_min,gas_max,sample_count,verified,source,captured_at').eq('user_id', user.id).order('sample_count', { ascending: false }).limit(20)
      if (contractAddress) query = query.eq('contract_address', contractAddress)
      if (chain) query = query.eq('chain', chain)
      const { data, error } = await query
      if (error) throw error
      return res.status(200).json({ ok: true, profiles: data || [] })
    } catch (err) {
      if (captureSchemaError(err)) return res.status(200).json({ ok: true, profiles: [] })
      return res.status(500).json({ error: 'Failed to list profiles' })
    }
  }

  // ── stats ─────────────────────────────────────────────────────────────────────
  if (subAction === 'stats') {
    const contractAddress = normCaptureAddr(req.query.contractAddress || req.query.contract_address)
    if (!contractAddress) return res.status(400).json({ error: 'contractAddress required' })
    try {
      const { data, error } = await supabase.from(CAPTURE_TABLE).select('id,protocol,mint_function,selector,gas_avg,sample_count,verified,proof_required,source').eq('contract_address', contractAddress).order('sample_count', { ascending: false }).limit(5)
      if (error) throw error
      const profiles = data || []
      const top = profiles[0] || null
      return res.status(200).json({ ok: true, hasProfile: profiles.length > 0, totalSamples: profiles.reduce((s, p) => s + (p.sample_count || 1), 0), protocol: top?.protocol || null, mintFunction: top?.mint_function || null, gasAvg: top?.gas_avg || null, proofRequired: top?.proof_required || false, verified: top?.verified || false, profiles })
    } catch (err) {
      if (captureSchemaError(err)) return res.status(200).json({ ok: true, hasProfile: false, totalSamples: 0, profiles: [] })
      return res.status(500).json({ error: 'Failed to load stats' })
    }
  }

  // ── delete ─────────────────────────────────────────────────────────────────────
  if (subAction === 'delete') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' })
    const { profileId } = req.body || {}
    if (!profileId) return res.status(400).json({ error: 'profileId required' })
    try {
      const { error } = await supabase.from(CAPTURE_TABLE).delete().eq('id', profileId).eq('user_id', user.id)
      if (error && !captureSchemaError(error)) throw error
      return res.status(200).json({ ok: true })
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete profile' })
    }
  }

  return res.status(404).json({ error: 'Unknown capture action' })
}
