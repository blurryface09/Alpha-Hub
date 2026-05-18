/**
 * Alert persistence and deduplication.
 * Writes to the notifications table with dedup checks.
 * Always silently handles errors — alerts must never block execution.
 */

import { createLogger } from './logger.js'

const log = createLogger(null, null)

// ─── Dedup windows per alert type ────────────────────────────────────────────

const DEDUP_WINDOWS_MS = {
  project_live:       30 * 60 * 1000,   // 30 min — fire at most once per 30min
  stealth_delay:       2 * 60 * 60 * 1000,  // 2 hours
  schedule_changed:   60 * 60 * 1000,   // 1 hour
  price_changed:      60 * 60 * 1000,
  supply_changed:      4 * 60 * 60 * 1000,  // 4 hours
  contract_deployed:  24 * 60 * 60 * 1000,  // once per day
  project_cancelled:  24 * 60 * 60 * 1000,
  status_changed:     60 * 60 * 1000,
  whale_mint:          5 * 60 * 1000,   // per-tx (short window; tx_hash in data is unique key)
  whale_move:          5 * 60 * 1000,
  default:            60 * 60 * 1000,
}

// ─── createAlert ─────────────────────────────────────────────────────────────

/**
 * Create an alert (notification row) with deduplication.
 * Returns the inserted alert id, or null if deduped / error.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   userId:      string,
 *   type:        string,
 *   title:       string,
 *   message:     string,
 *   severity?:   'critical'|'warning'|'info',
 *   dedupKey?:   string|null,
 *   dedupWindowMs?: number|null,
 *   data?:       object,
 * }} opts
 * @returns {Promise<string|null>}
 */
export async function createAlert(supabase, {
  userId,
  type,
  title,
  message,
  severity      = 'info',
  dedupKey      = null,
  dedupWindowMs = null,
  data          = {},
}) {
  if (!userId || !type || !title) return null

  try {
    // ── Dedup check ──────────────────────────────────────────────────────────
    if (dedupKey) {
      const windowMs = dedupWindowMs ?? DEDUP_WINDOWS_MS[type] ?? DEDUP_WINDOWS_MS.default
      const cutoff   = new Date(Date.now() - windowMs).toISOString()

      const { data: recent } = await supabase
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('type', type)
        .gte('created_at', cutoff)
        .filter('data->>dedup_key', 'eq', dedupKey)
        .limit(1)

      if (recent?.length) {
        log.info('alerter', 'Alert deduped', { type, dedup_key: dedupKey })
        return null
      }
    }

    // ── Insert ───────────────────────────────────────────────────────────────
    const { data: inserted, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type,
        title,
        message,
        data:    { ...data, severity, dedup_key: dedupKey },
      })
      .select('id')
      .maybeSingle()

    if (error) {
      log.warn('alerter', 'Alert insert failed', { error: error.message, type })
      return null
    }

    log.info('alerter', 'Alert created', { type, severity, title })
    return inserted?.id ?? null

  } catch (err) {
    log.warn('alerter', 'Alert creation threw', { error: err.message, type })
    return null
  }
}

// ─── getAlertHistory ─────────────────────────────────────────────────────────

/**
 * Paginated alert history for a user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {{ limit?: number, offset?: number, type?: string|null }} [opts]
 * @returns {Promise<object[]>}
 */
export async function getAlertHistory(supabase, userId, { limit = 50, offset = 0, type = null } = {}) {
  let query = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (type) query = query.eq('type', type)

  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

// ─── markAlertRead ────────────────────────────────────────────────────────────

/**
 * Mark a single alert as read.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} alertId
 */
export async function markAlertRead(supabase, userId, alertId) {
  await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', alertId)
    .eq('user_id', userId)
}

// ─── getDedupWindowMs ────────────────────────────────────────────────────────

export function getDedupWindowMs(type) {
  return DEDUP_WINDOWS_MS[type] ?? DEDUP_WINDOWS_MS.default
}
