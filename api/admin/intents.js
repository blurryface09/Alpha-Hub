/**
 * GET /api/admin/intents
 *
 * Returns mint_intents across all users for the execution monitor.
 * Admin-only. Uses service role key to bypass RLS.
 *
 * Query params:
 *   filter  — all | failed | pending | ready | executed | waiting  (default: all)
 *   limit   — max rows (default: 60, max: 100)
 *   search  — substring match on contract_address or tx_hash
 */

import { createServiceClient, requireAdmin } from '../_lib/auth.js'

const STATUS_FILTERS = {
  failed:   { statuses: ['failed', 'expired'] },
  pending:  { statuses: ['executing', 'retrying', 'pending', 'submitted'] },
  ready:    { statuses: ['armed', 'watching', 'prepared'], strikeEnabled: true },
  executed: { statuses: ['success', 'confirmed'] },
  waiting:  { statuses: ['armed', 'watching', 'prepared'], strikeEnabled: false },
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const supabase = createServiceClient()
  const filter   = req.query.filter  || 'all'
  const limit    = Math.min(Number(req.query.limit) || 60, 100)
  const search   = String(req.query.search || '').trim().toLowerCase()

  let query = supabase
    .from('mint_intents')
    .select(`
      id,
      user_id,
      status,
      chain,
      contract_address,
      mint_contract_address,
      to,
      value,
      function_name,
      last_state,
      strike_error,
      simulation_status,
      tx_hash,
      strike_execute_at,
      strike_enabled,
      wl_project_id,
      updated_at,
      created_at,
      wl_projects ( name )
    `)
    .order('updated_at', { ascending: false })
    .limit(limit)

  const cond = STATUS_FILTERS[filter]
  if (cond) {
    query = query.in('status', cond.statuses)
    if (cond.strikeEnabled !== undefined) {
      query = query.eq('strike_enabled', cond.strikeEnabled)
    }
  }

  if (search) {
    query = query.or(
      `contract_address.ilike.%${search}%,tx_hash.ilike.%${search}%`,
    )
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  // Counts by status for filter badges
  const { data: counts } = await supabase
    .from('mint_intents')
    .select('status, strike_enabled')
    .limit(500)

  const statusCounts = { all: 0, failed: 0, pending: 0, ready: 0, executed: 0, waiting: 0 }
  for (const row of counts || []) {
    statusCounts.all++
    if (['failed', 'expired'].includes(row.status))                                         statusCounts.failed++
    else if (['executing', 'retrying', 'pending', 'submitted'].includes(row.status))        statusCounts.pending++
    else if (['armed', 'watching', 'prepared'].includes(row.status) && row.strike_enabled)  statusCounts.ready++
    else if (['success', 'confirmed'].includes(row.status))                                 statusCounts.executed++
    else if (['armed', 'watching', 'prepared'].includes(row.status) && !row.strike_enabled) statusCounts.waiting++
  }

  return res.json({ intents: data || [], counts: statusCounts })
}
