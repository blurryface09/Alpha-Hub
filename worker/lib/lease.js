/**
 * Worker lease and heartbeat management.
 * Provides advisory single-worker coordination via DB heartbeats.
 * A lease is acquired at boot and renewed on each heartbeat interval.
 * Stale leases (missed heartbeats) are detectable by other workers and recovery sweeps.
 *
 * This is advisory, not a hard mutex — if DB is unavailable, the worker continues.
 * Intent-level atomic claims in queue.js are the real conflict prevention layer.
 */

import { createLogger } from './logger.js'

const log = createLogger(null, null)

// ─── Constants ────────────────────────────────────────────────────────────────

/** A lease is considered expired if last_seen_at is older than this. */
export const LEASE_TIMEOUT_MS = 90_000 // 90 seconds — 3× the default heartbeat interval

// ─── Worker identity ──────────────────────────────────────────────────────────

let _workerId = null

/** Return a stable worker ID for this process lifetime. */
export function getWorkerId() {
  if (!_workerId) {
    _workerId = `worker-${process.pid}-${Date.now().toString(36)}`
  }
  return _workerId
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Return true if the given ISO timestamp is older than timeoutMs.
 * @param {string|null} lastSeenAt  — ISO timestamp
 * @param {number} timeoutMs
 * @returns {boolean}
 */
export function isLeaseExpired(lastSeenAt, timeoutMs = LEASE_TIMEOUT_MS) {
  if (!lastSeenAt) return true
  const ageMs = Date.now() - new Date(lastSeenAt).getTime()
  return ageMs > timeoutMs
}

/**
 * Parse a lease metadata object from a mint_execution_events row.
 * Returns null if the row doesn't contain valid lease data.
 *
 * @param {object|null} row
 * @returns {{ worker_id: string, last_seen_at: string, pid: number }|null}
 */
export function parseLeaseMeta(row) {
  const meta = row?.metadata
  if (!meta?.worker_id || !meta?.last_seen_at) return null
  return meta
}

// ─── DB operations ────────────────────────────────────────────────────────────

/**
 * Write a lease heartbeat row to mint_execution_events.
 * Uses state='worker_lease' and intent_id=null as the sentinel pattern.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workerId
 * @param {'acquire'|'renew'|'release'} action
 */
async function writeLease(supabase, workerId, action) {
  await supabase.from('mint_execution_events').insert({
    intent_id: null,
    user_id:   null,
    state:     'worker_lease',
    message:   `Worker lease ${action}: ${workerId}`,
    metadata:  {
      worker_id:    workerId,
      last_seen_at: new Date().toISOString(),
      pid:          process.pid,
      action,
    },
  })
}

/**
 * Acquire a worker lease. If another worker holds an active (non-expired) lease,
 * returns { acquired: false, conflictingWorker }. Otherwise writes and returns
 * { acquired: true, workerId }.
 *
 * Silently succeeds if the DB is unavailable (advisory only).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ acquired: boolean, workerId: string, conflictingWorker?: string }>}
 */
export async function acquireLease(supabase, timeoutMs = LEASE_TIMEOUT_MS) {
  const workerId = getWorkerId()

  try {
    const conflict = await checkForConflictingLeases(supabase, workerId, timeoutMs)
    if (conflict) {
      log.warn('lease', 'Another worker holds an active lease', {
        conflicting_worker: conflict.worker_id,
        last_seen_at: conflict.last_seen_at,
      })
      return { acquired: false, workerId, conflictingWorker: conflict.worker_id }
    }

    await writeLease(supabase, workerId, 'acquire')
    log.info('lease', 'Worker lease acquired', { worker_id: workerId })
    return { acquired: true, workerId }
  } catch (err) {
    log.warn('lease', 'Failed to acquire worker lease (DB unavailable — continuing)', {
      error: err.message,
    })
    return { acquired: true, workerId } // advisory — keep running
  }
}

/**
 * Renew the worker lease by writing a fresh heartbeat row.
 * Silently no-ops if DB is unavailable.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} [workerId]  — defaults to this process's worker ID
 */
export async function renewLease(supabase, workerId = getWorkerId()) {
  try {
    await writeLease(supabase, workerId, 'renew')
  } catch (err) {
    log.warn('lease', 'Failed to renew worker lease', { error: err.message, worker_id: workerId })
  }
}

/**
 * Check for an active (non-expired) lease held by a *different* worker.
 * Returns the conflicting lease metadata, or null if no conflict.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} ownWorkerId
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
export async function checkForConflictingLeases(supabase, ownWorkerId, timeoutMs = LEASE_TIMEOUT_MS) {
  try {
    const { data } = await supabase
      .from('mint_execution_events')
      .select('metadata, created_at')
      .eq('state', 'worker_lease')
      .is('intent_id', null)
      .order('created_at', { ascending: false })
      .limit(5)

    if (!data?.length) return null

    for (const row of data) {
      const meta = parseLeaseMeta(row)
      if (!meta) continue
      if (meta.worker_id === ownWorkerId) return null // that's us
      if (!isLeaseExpired(meta.last_seen_at, timeoutMs)) {
        return meta // active lease from another worker
      }
    }

    return null
  } catch {
    return null // advisory — DB error means no conflict detected
  }
}

/**
 * Return a summary of the most recent worker lease state from DB.
 * Useful for diagnostics and heartbeat logs.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<object|null>}
 */
export async function getLeaseSummary(supabase) {
  try {
    const { data } = await supabase
      .from('mint_execution_events')
      .select('metadata, created_at')
      .eq('state', 'worker_lease')
      .is('intent_id', null)
      .order('created_at', { ascending: false })
      .limit(1)

    if (!data?.[0]) return null
    const meta = parseLeaseMeta(data[0])
    if (!meta) return null

    return {
      ...meta,
      expired: isLeaseExpired(meta.last_seen_at),
    }
  } catch {
    return null
  }
}
