/**
 * Project watchlist endpoint — follow / unfollow calendar projects.
 *
 * GET  /api/watchlist?project_id=<uuid>  — is user following this project?
 * POST /api/watchlist { project_id }     — follow a project
 * DELETE /api/watchlist { project_id }   — unfollow a project
 */

import { createServiceClient, requireUser } from './_lib/auth.js'

export default async function handler(req, res) {
  try {
    const user = await requireUser(req, res)
    if (!user) return  // requireUser already sent 401

    const projectId = req.query.project_id || req.body?.project_id
    if (!projectId) return res.status(400).json({ error: 'project_id required' })

    const supabase = createServiceClient()

    // ── GET — check follow status ────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data } = await supabase
        .from('calendar_project_watchers')
        .select('id')
        .eq('user_id', user.id)
        .eq('project_id', projectId)
        .maybeSingle()

      return res.status(200).json({ following: Boolean(data) })
    }

    // ── POST — follow ────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { error } = await supabase
        .from('calendar_project_watchers')
        .upsert({
          user_id:    user.id,
          project_id: projectId,
        }, { onConflict: 'project_id,user_id', ignoreDuplicates: true })

      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, following: true })
    }

    // ── DELETE — unfollow ────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('calendar_project_watchers')
        .delete()
        .eq('user_id', user.id)
        .eq('project_id', projectId)

      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, following: false })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (e) {
    console.error('watchlist error:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
