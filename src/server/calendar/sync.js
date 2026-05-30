import { dedupeKey } from './normalize.js'
import { scoreProject } from './scoring.js'
import { fetchOpenSeaProjects } from './adapters/opensea.js'
import { fetchAlchemyProjects } from './adapters/alchemy.js'
import { fetchZoraProjects } from './adapters/zora.js'
import { fetchOnchainProjects } from './adapters/onchain.js'
import { isRawCalendarDiscovery } from '../../lib/calendarQuality.js'

const EXTENDED_PROJECT_FIELDS = [
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

const ADAPTERS = {
  opensea: fetchOpenSeaProjects,
  alchemy: fetchAlchemyProjects,
  zora: fetchZoraProjects,
  onchain: fetchOnchainProjects,
}

function isSchemaError(error) {
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

function emptySource() {
  return { imported: 0, updated: 0, errors: [] }
}

function isColumnShapeError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('schema cache') || message.includes('column') || message.includes('violates unique')
}

function stripExtendedFields(project) {
  const clean = { ...project }
  EXTENDED_PROJECT_FIELDS.forEach(field => delete clean[field])
  return clean
}

// Sources trusted enough for auto-approval when quality score is sufficient.
// purgeStaleProjects() will demote them back to pending_review if they later
// lose required fields (contract_address, mint_date), so this is safe.
const TRUSTED_SYNC_SOURCES = new Set(['opensea_drops', 'opensea', 'alchemy', 'zora'])

function resolveInsertStatus(scored) {
  if (scored.status === 'live' || scored.status === 'ended') return scored.status
  if (scored.status === 'pending_review' && TRUSTED_SYNC_SOURCES.has(scored.source) && scored.quality_score >= 50) {
    const mintMs = scored.mint_date ? new Date(scored.mint_date).getTime() : null
    // Accept anything in the past 72h (may still be running), or explicitly upcoming/live
    const hasTimeSignal = (mintMs && mintMs > Date.now() - 72 * 3600 * 1000) ||
      ['live_now', 'upcoming'].includes(scored.mint_status)
    if (hasTimeSignal) return 'approved'
  }
  return scored.status
}

async function upsertProject(supabase, project) {
  const scored = scoreProject(project)
  let existing = null

  if (scored.contract_address) {
    const { data } = await supabase
      .from('calendar_projects')
      .select('id,first_seen_at,status')
      .eq('chain', scored.chain)
      .eq('contract_address', scored.contract_address)
      .maybeSingle()
    existing = data
  }

  if (!existing && scored.source_url) {
    const { data } = await supabase
      .from('calendar_projects')
      .select('id,first_seen_at,status')
      .eq('source_url', scored.source_url)
      .maybeSingle()
    existing = data
  }

  if (existing?.id) {
    // Protect admin locks and live status — never let a weaker sync payload downgrade them.
    // 'live' can only move to 'ended'; everything else is held unless the new score upgrades it.
    const resolvedStatus = resolveInsertStatus(scored)
    const nextStatus = ['hidden', 'rejected'].includes(existing.status)
      ? existing.status
      : existing.status === 'live' && resolvedStatus !== 'ended'
        ? 'live'
        : resolvedStatus
    let { error } = await supabase
      .from('calendar_projects')
      .update({
        ...scored,
        first_seen_at: existing.first_seen_at || scored.first_seen_at,
        status: nextStatus,
      })
      .eq('id', existing.id)
    if (error && isColumnShapeError(error)) {
      const fallback = stripExtendedFields(scored)
      const retry = await supabase
        .from('calendar_projects')
        .update({
          ...fallback,
          first_seen_at: existing.first_seen_at || fallback.first_seen_at,
          status: nextStatus,
        })
        .eq('id', existing.id)
      error = retry.error
    }
    if (error) throw error
    return 'updated'
  }

  const insertPayload = { ...scored, status: resolveInsertStatus(scored) }
  let { error } = await supabase.from('calendar_projects').insert(insertPayload)
  if (error && isColumnShapeError(error)) {
    const retry = await supabase.from('calendar_projects').insert(stripExtendedFields(insertPayload))
    error = retry.error
  }
  if (error) throw error
  return 'imported'
}

async function downgradeWeakDiscoveryRows(supabase) {
  let result = await supabase
    .from('calendar_projects')
    .select('id,name,source,status,source_confidence,image_url,website_url,mint_url,source_url,quality_score')
    .in('source', ['opensea', 'onchain'])
    .in('status', ['approved', 'live'])
    .limit(200)
  if (result.error && isColumnShapeError(result.error)) {
    result = await supabase
      .from('calendar_projects')
      .select('id,name,source,status,source_confidence,image_url,website_url,mint_url,source_url')
      .in('source', ['opensea', 'onchain'])
      .in('status', ['approved', 'live'])
      .limit(200)
  }
  if (result.error) throw result.error

  const weakIds = (result.data || [])
    .filter(row => row.source === 'onchain' || isRawCalendarDiscovery(row))
    .map(row => row.id)

  if (!weakIds.length) return 0
  const { error } = await supabase
    .from('calendar_projects')
    .update({ status: 'pending_review', updated_at: new Date().toISOString() })
    .in('id', weakIds)
  if (error) throw error
  return weakIds.length
}

async function purgeStaleProjects(supabase) {
  const now = new Date().toISOString()
  const summary = { markedEnded: 0, pendingReview: 0 }

  // Mark ended: mint_end_date is in the past and not already ended
  const { data: endedRows, error: endedErr } = await supabase
    .from('calendar_projects')
    .select('id')
    .lt('mint_end_date', now)
    .not('status', 'in', '("ended","hidden","rejected")')
    .not('mint_status', 'eq', 'live_now')
    .limit(200)
  if (!endedErr && endedRows?.length) {
    await supabase
      .from('calendar_projects')
      .update({ status: 'ended', updated_at: now })
      .in('id', endedRows.map(r => r.id))
    summary.markedEnded = endedRows.length
  }

  // Move to pending_review: no contract_address or no mint_date (non-admin, non-community).
  // Never downgrade live_now projects — they may be actively minting without a stored mint_date.
  const { data: incompleteRows, error: incompleteErr } = await supabase
    .from('calendar_projects')
    .select('id,contract_address,mint_date,mint_status')
    .in('status', ['approved', 'live'])
    .not('source', 'in', '("admin","community")')
    .limit(500)
  if (!incompleteErr && incompleteRows?.length) {
    const badIds = incompleteRows
      .filter(r => r.mint_status !== 'live_now')
      .filter(r => !r.contract_address || !r.mint_date)
      .map(r => r.id)
    if (badIds.length) {
      await supabase
        .from('calendar_projects')
        .update({ status: 'pending_review', updated_at: now })
        .in('id', badIds)
      summary.pendingReview = badIds.length
    }
  }

  console.log('[calendar-sync] purgeStaleProjects', summary)
  return summary
}

export async function runCalendarSync(supabase, { sources = Object.keys(ADAPTERS), limit = 12 } = {}) {
  const summary = {
    ok: true,
    sources: {},
    totalImported: 0,
    totalUpdated: 0,
    ts: new Date().toISOString(),
  }
  const seen = new Set()

  for (const source of sources) {
    const adapter = ADAPTERS[source]
    if (!adapter) continue
    const sourceSummary = emptySource()
    summary.sources[source] = sourceSummary

    try {
      const result = await adapter({ limit })
      sourceSummary.errors.push(...(result.errors || []))

      for (const project of result.projects || []) {
        const key = dedupeKey(project)
        if (seen.has(key)) continue
        seen.add(key)

        try {
          const action = await upsertProject(supabase, project)
          if (action === 'imported') sourceSummary.imported += 1
          if (action === 'updated') sourceSummary.updated += 1
        } catch (error) {
          sourceSummary.errors.push(error.message)
        }
      }
    } catch (error) {
      sourceSummary.errors.push(error.message)
    }

    summary.totalImported += sourceSummary.imported
    summary.totalUpdated += sourceSummary.updated

    try {
      await supabase.from('calendar_sync_runs').insert({
        source,
        status: sourceSummary.errors.length ? 'degraded' : 'healthy',
        imported_count: sourceSummary.imported,
        updated_count: sourceSummary.updated,
        error_count: sourceSummary.errors.length,
        errors: sourceSummary.errors,
        started_at: summary.ts,
        finished_at: new Date().toISOString(),
      })
    } catch {}
  }

  try {
    summary.downgradedForReview = await downgradeWeakDiscoveryRows(supabase)
  } catch (error) {
    summary.cleanupError = error.message
  }

  try {
    summary.staleCleanup = await purgeStaleProjects(supabase)
  } catch (error) {
    summary.staleCleanupError = error.message
  }

  return summary
}

export async function getCalendarStatus(supabase) {
  const [projects, runs] = await Promise.all([
    supabase.from('calendar_projects').select('status,source,mint_date', { count: 'exact' }).limit(1000),
    supabase.from('calendar_sync_runs').select('*').order('created_at', { ascending: false }).limit(20),
  ])

  if (isSchemaError(projects.error) || isSchemaError(runs.error)) {
    return {
      ok: false,
      schemaMissing: true,
      message: 'Calendar database table is not installed yet. Apply the Calendar SQL migration, then run sync.',
      lastSync: null,
      projectCount: 0,
      upcomingCount: 0,
      liveCount: 0,
      pendingCount: 0,
      newContractCount: 0,
      sources: {},
    }
  }

  const rows = projects.data || []
  const now = Date.now()
  const liveCount = rows.filter(row => row.mint_status === 'live_now' || row.status === 'live').length
  const upcomingCount = rows.filter(row => row.status === 'approved' && row.mint_date && new Date(row.mint_date).getTime() > now).length
  const pendingCount = rows.filter(row => row.status === 'pending_review').length
  const newContractCount = rows.filter(row => row.source === 'onchain').length
  const latestRun = (runs.data || [])[0]
  const knownSources = Object.keys(ADAPTERS)
  const sourceRuns = {}
  for (const source of knownSources) {
    sourceRuns[source] = {
      status: 'not_run',
      imported: 0,
      updated: 0,
      errors: [],
      finishedAt: null,
    }
  }
  for (const run of runs.data || []) {
    if (!knownSources.includes(run.source) || sourceRuns[run.source]?.finishedAt) continue
    sourceRuns[run.source] = {
      status: run.status,
      imported: run.imported_count || 0,
      updated: run.updated_count || 0,
      errors: run.errors || [],
      finishedAt: run.finished_at || run.created_at,
    }
  }

  return {
    ok: !projects.error,
    schemaMissing: false,
    lastSync: latestRun?.finished_at || latestRun?.created_at || null,
    projectCount: projects.count || rows.length,
    upcomingCount,
    liveCount,
    pendingCount,
    newContractCount,
    sources: sourceRuns,
  }
}
