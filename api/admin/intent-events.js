/**
 * GET /api/admin/intent-events?id=<intent_id>
 *
 * Returns the last 8 execution events for a single intent.
 * Admin-only. Used by the expanded row in ExecutionMonitorPage.
 */

import { createServiceClient, requireAdmin } from '../_lib/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'intent id required' })

  const supabase = createServiceClient()

  const [{ data: events, error: evErr }, { data: attempts, error: attErr }] = await Promise.all([
    supabase
      .from('mint_execution_events')
      .select('id, state, message, metadata, created_at')
      .eq('intent_id', id)
      .order('created_at', { ascending: false })
      .limit(8),
    supabase
      .from('mint_attempts')
      .select('status, tx_hash, error_message, created_at')
      .or(`intent_id.eq.${id},mint_intent_id.eq.${id}`)
      .order('created_at', { ascending: false })
      .limit(3),
  ])

  if (evErr) return res.status(500).json({ error: evErr.message })

  return res.json({
    events:   events   || [],
    attempts: attempts || [],
  })
}
