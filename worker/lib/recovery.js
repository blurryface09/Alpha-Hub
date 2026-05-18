/**
 * Execution recovery and queue reconciliation.
 * Rescues intents that get stuck in transition states (network failures, process
 * crashes, or racing workers). Queue reconciliation runs periodically in the tick.
 * All operations are idempotent and safe to run concurrently.
 */

import { createLogger }  from './logger.js'
import { nonceTracker }  from './retry.js'
import { INTENT_STATES } from './queue.js'

const log = createLogger(null, null)

// ─── Constants ────────────────────────────────────────────────────────────────

/** Intents stuck in an executing state longer than this are considered orphaned. */
export const ORPHAN_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/** Map from orphaned state back to the state we recover into. */
const RECOVERY_STATE = {
  [INTENT_STATES.EXECUTING]:         INTENT_STATES.ARMED,
  [INTENT_STATES.EXECUTING_SIM]:     INTENT_STATES.ARMED,
  [INTENT_STATES.EXECUTING_TESTNET]: INTENT_STATES.SIM_SUCCESS,
}

const ORPHANABLE_STATES = Object.keys(RECOVERY_STATE)

// ─── Stuck nonce recovery ─────────────────────────────────────────────────────

/**
 * Detect and recover a stuck nonce for a wallet address.
 * Compares the chain's pending nonce with the in-process tracker.
 * Updates the tracker if the chain has advanced (txs confirmed while we weren't watching).
 *
 * @param {import('viem').PublicClient} publicClient
 * @param {string} address
 * @returns {Promise<{
 *   recovered: boolean,
 *   chainNonce: number,
 *   trackedNonce: number|undefined,
 *   reason?: string,
 * }>}
 */
export async function recoverStuckNonce(publicClient, address) {
  const chainNonce   = await publicClient.getTransactionCount({ address, blockTag: 'pending' })
  const trackedNonce = nonceTracker.get(address)

  if (trackedNonce === undefined) {
    // Not tracked yet — seed it from chain
    nonceTracker.set(address, chainNonce)
    return { recovered: true, chainNonce, trackedNonce, reason: 'seeded_from_chain' }
  }

  if (chainNonce > trackedNonce) {
    // Chain advanced past our tracker — txs confirmed while we weren't looking
    log.info('recovery', 'Nonce recovery: chain ahead of tracker', {
      address,
      chain_nonce:   chainNonce,
      tracked_nonce: trackedNonce,
      delta:         chainNonce - trackedNonce,
    })
    nonceTracker.set(address, chainNonce)
    return {
      recovered:    true,
      chainNonce,
      trackedNonce,
      reason:       'chain_advanced',
      delta:        chainNonce - trackedNonce,
    }
  }

  if (chainNonce < trackedNonce) {
    // Tracker ahead of chain — possible chain reorg, reset or fresh node
    log.warn('recovery', 'Nonce recovery: tracker ahead of chain (possible reorg)', {
      address,
      chain_nonce:   chainNonce,
      tracked_nonce: trackedNonce,
    })
    nonceTracker.set(address, chainNonce)
    return {
      recovered:    true,
      chainNonce,
      trackedNonce,
      reason:       'tracker_reset_to_chain',
    }
  }

  return { recovered: false, chainNonce, trackedNonce }
}

// ─── Orphan recovery ──────────────────────────────────────────────────────────

/**
 * Find intents stuck in an executing state beyond the orphan timeout and
 * reset them to their recovery state. The reset uses an optimistic write
 * (.eq('status', orphanedStatus)) so it races cleanly with an executing worker.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} [timeoutMs]
 * @returns {Promise<number>} count of intents recovered
 */
export async function sweepOrphanedExecutions(supabase, timeoutMs = ORPHAN_TIMEOUT_MS) {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString()

  const { data: orphans, error } = await supabase
    .from('mint_intents')
    .select('id, user_id, status, updated_at')
    .in('status', ORPHANABLE_STATES)
    .lt('updated_at', cutoff)
    .limit(20)

  if (error) {
    log.error('recovery', 'Failed to query orphaned executions', { error: error.message })
    return 0
  }
  if (!orphans?.length) return 0

  let recovered = 0
  for (const intent of orphans) {
    const recoverTo = RECOVERY_STATE[intent.status]
    if (!recoverTo) continue

    const { error: updateErr } = await supabase
      .from('mint_intents')
      .update({
        status:     recoverTo,
        last_state: `Recovered from orphaned ${intent.status} (timed out >${Math.round(timeoutMs / 60_000)}min)`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', intent.id)
      .eq('status', intent.status) // optimistic: only update if still in the expected state

    if (updateErr) continue

    await supabase.from('mint_execution_events').insert({
      intent_id: intent.id,
      user_id:   intent.user_id,
      state:     'orphan_recovered',
      message:   `Orphan recovery: ${intent.status} → ${recoverTo} (stuck since ${intent.updated_at})`,
      metadata:  {
        orphaned_status: intent.status,
        recovered_to:    recoverTo,
        orphaned_since:  intent.updated_at,
        timeout_ms:      timeoutMs,
      },
    }).catch(() => null)

    log.info('recovery', 'Orphaned intent recovered', {
      intent_id:  intent.id,
      from_state: intent.status,
      to_state:   recoverTo,
    })

    recovered++
  }

  return recovered
}

// ─── Queue reconciliation ─────────────────────────────────────────────────────

/**
 * Run all recovery and reconciliation sweeps in one call.
 * Called periodically from the worker tick to self-heal the queue.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ orphanTimeoutMs?: number }} [opts]
 * @returns {Promise<{ orphansRecovered: number, queueHealth: object }>}
 */
export async function reconcileQueue(supabase, opts = {}) {
  const { orphanTimeoutMs = ORPHAN_TIMEOUT_MS } = opts

  const orphansRecovered = await sweepOrphanedExecutions(supabase, orphanTimeoutMs)

  // Snapshot queue state for health reporting
  const { data: counts } = await supabase
    .from('mint_intents')
    .select('status')
    .eq('strike_enabled', true)
    .in('status', [
      INTENT_STATES.ARMED,
      INTENT_STATES.EXECUTING_SIM,
      INTENT_STATES.SIM_SUCCESS,
      INTENT_STATES.SIM_FAILED,
      INTENT_STATES.EXECUTING_TESTNET,
      INTENT_STATES.TESTNET_FAILED,
    ])

  const queueHealth = {}
  for (const row of counts ?? []) {
    queueHealth[row.status] = (queueHealth[row.status] ?? 0) + 1
  }

  if (orphansRecovered > 0 || Object.keys(queueHealth).length > 0) {
    log.info('recovery', 'Queue reconciliation complete', {
      orphans_recovered: orphansRecovered,
      queue_health:      queueHealth,
    })
  }

  return { orphansRecovered, queueHealth }
}
