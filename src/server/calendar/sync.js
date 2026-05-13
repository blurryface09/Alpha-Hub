import { dedupeKey } from './normalize.js'
import { scoreProject } from './scoring.js'
import { fetchOpenSeaProjects } from './adapters/opensea.js'
import { fetchReservoirProjects } from './adapters/reservoir.js'
import { fetchZoraProjects } from './adapters/zora.js'
import { fetchOnchainProjects } from './adapters/onchain.js'

const ADAPTERS = {
  opensea: fetchOpenSeaProjects,
  reservoir: fetchReservoirProjects,
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
    const { error } = await supabase
      .from('calendar_projects')
      .update({
        ...scored,
        first_seen_at: existing.first_seen_at || scored.first_seen_at,
        status: existing.status === 'hidden' || existing.status === 'rejected' ? existing.status : scored.status,
      })
      .eq('id', existing.id)
    if (error) throw error
    return 'updated'
  }

  const { error } = await supabase.from('calendar_projects').insert(scored)
  if (error) throw error
  return 'imported'
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
  const liveCount = rows.filter(row => row.status === 'live' || (row.mint_date && new Date(row.mint_date).getTime() <= now)).length
  const upcomingCount = rows.filter(row => row.status === 'approved' && row.mint_date && new Date(row.mint_date).getTime() > now).length
  const pendingCount = rows.filter(row => row.status === 'pending_review').length
  const newContractCount = rows.filter(row => row.source === 'onchain').length
  const latestRun = (runs.data || [])[0]

  return {
    ok: !projects.error,
    schemaMissing: false,
    lastSync: latestRun?.finished_at || latestRun?.created_at || null,
    projectCount: projects.count || rows.length,
    upcomingCount,
    liveCount,
    pendingCount,
    newContractCount,
    sources: Object.fromEntries((runs.data || []).map(run => [
      run.source,
      {
        status: run.status,
        imported: run.imported_count || 0,
        updated: run.updated_count || 0,
        errors: run.errors || [],
        finishedAt: run.finished_at || run.created_at,
      },
    ])),
  }
}
