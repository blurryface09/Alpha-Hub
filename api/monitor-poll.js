/**
 * Project monitoring cron.
 * Runs every 5 minutes via Vercel Cron.
 * Revalidates watched projects, detects changes (status, price, schedule,
 * contract, supply), fires deduped alerts, and updates monitor state.
 * Always returns 200 to prevent Vercel from disabling the cron.
 */

import { createClient } from '@supabase/supabase-js'

// Import monitoring engine
// Note: these are worker-local modules; Vercel bundles them at build time
import {
  detectProjectChanges,
  detectStealthDelay,
  shouldCheckThisTick,
  buildDedupKey,
  buildAlertTitle,
  buildAlertMessage,
  ALERT_TYPES,
} from '../worker/lib/monitor.js'

import { createAlert } from '../worker/lib/alerter.js'

const TICK_INTERVAL_MS = 5 * 60 * 1000  // 5 min
const BATCH_SIZE       = 40

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export default async function handler(req, res) {
  try {
    const supabase = getSupabase()
    if (!supabase) {
      return res.status(200).json({ ok: false, error: 'Missing env vars' })
    }

    const nowMs = Date.now()

    // Fetch active watchers joined with project data
    const { data: watchers, error: watcherErr } = await supabase
      .from('calendar_project_watchers')
      .select(`
        id,
        user_id,
        project_id,
        calendar_projects!inner (
          id, name, status, mint_date, mint_price, contract_address, chain, supply
        )
      `)
      .limit(BATCH_SIZE)

    if (watcherErr) {
      console.error('monitor-poll: watcher query failed:', watcherErr.message)
      return res.status(200).json({ ok: false, error: watcherErr.message })
    }

    if (!watchers?.length) {
      return res.status(200).json({ ok: true, checked: 0, alerted: 0 })
    }

    let checked = 0
    let alerted = 0

    for (const watcher of watchers) {
      const project = watcher.calendar_projects
      if (!project) continue

      try {
        // Fetch stored monitor state for this user+project
        const { data: stateRow } = await supabase
          .from('monitor_state')
          .select('*')
          .eq('user_id', watcher.user_id)
          .eq('entity_type', 'project')
          .eq('entity_id', watcher.project_id)
          .maybeSingle()

        // Backoff — skip if checked too recently
        if (stateRow && !shouldCheckThisTick(project, stateRow.last_checked_at, TICK_INTERVAL_MS, nowMs)) {
          continue
        }

        checked++

        // Detect field changes
        const changes = detectProjectChanges(stateRow, project)

        // Stealth delay detection
        if (detectStealthDelay(project, nowMs)) {
          changes.push({
            type:     ALERT_TYPES.STEALTH_DELAY,
            severity: 'warning',
            field:    'status',
            from:     project.status,
            to:       'delayed',
          })
        }

        // Fire one alert per detected change (with dedup)
        for (const change of changes) {
          const dedupKey = buildDedupKey(change.type, watcher.project_id)
          const id = await createAlert(supabase, {
            userId:   watcher.user_id,
            type:     change.type,
            title:    buildAlertTitle(change.type, project.name),
            message:  buildAlertMessage(change.type, change, project),
            severity: change.severity,
            dedupKey,
            data: {
              project_id:   watcher.project_id,
              project_name: project.name,
              chain:        project.chain,
              change_from:  change.from,
              change_to:    change.to,
              field:        change.field,
            },
          })
          if (id) alerted++
        }

        // Upsert monitor state with fresh values
        await supabase
          .from('monitor_state')
          .upsert({
            user_id:         watcher.user_id,
            entity_type:     'project',
            entity_id:       watcher.project_id,
            last_status:     project.status,
            last_mint_date:  project.mint_date   ?? null,
            last_price:      project.mint_price  ?? null,
            last_supply:     project.supply      ?? null,
            last_contract:   project.contract_address ?? null,
            last_checked_at: new Date().toISOString(),
          }, { onConflict: 'user_id,entity_type,entity_id' })
          .catch(() => null)  // never block on state update failure

      } catch (err) {
        console.error(`monitor-poll: error processing watcher ${watcher.id}:`, err.message)
      }
    }

    return res.status(200).json({ ok: true, checked, alerted, ts: new Date().toISOString() })

  } catch (e) {
    console.error('monitor-poll fatal:', e.message)
    return res.status(200).json({ ok: false, error: e.message })
  }
}
