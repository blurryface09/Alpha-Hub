/**
 * Signing audit log.
 * Every signing operation (prepare / broadcast / confirmed / replaced / failed)
 * is written here. Failure to write MUST NOT block execution — this is advisory.
 */

import { createLogger } from './logger.js'

const log = createLogger(null, null)

// ─── Worker identity ──────────────────────────────────────────────────────────

let _workerId = null

/** Return or generate a stable worker ID for this process lifetime. */
export function getWorkerId() {
  if (!_workerId) {
    _workerId = `worker-${process.pid}-${Date.now().toString(36)}`
  }
  return _workerId
}

// ─── Audit event writer ───────────────────────────────────────────────────────

/**
 * Write a signing audit event to mint_execution_events.
 * Always silently ignores DB errors so callers never throw from here.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @param {{
 *   intentId:  string|null,
 *   userId:    string|null,
 *   address:   string,
 *   action:    'prepare'|'broadcast'|'confirmed'|'replaced'|'failed'|'cancelled',
 *   chain?:    string,
 *   txHash?:   string|null,
 *   blockNumber?: string|null,
 *   gasParams?: object|null,
 *   metadata?: object,
 * }} event
 */
export async function logSigningEvent(supabase, event) {
  const {
    intentId  = null,
    userId    = null,
    address,
    action,
    chain     = null,
    txHash    = null,
    blockNumber = null,
    gasParams = null,
    metadata  = {},
  } = event

  const workerId = getWorkerId()
  const message  = [
    `[AUDIT] ${action}`,
    `wallet: ${address}`,
    chain     ? `chain: ${chain}` : null,
    txHash    ? `tx: ${txHash}`   : null,
    blockNumber ? `block: ${blockNumber}` : null,
  ].filter(Boolean).join(' | ')

  log.info('audit', message, { action, address, chain, tx_hash: txHash, worker_id: workerId })

  if (!supabase) return

  try {
    await supabase.from('mint_execution_events').insert({
      intent_id: intentId,
      user_id:   userId,
      state:     'signing_audit',
      message,
      metadata: {
        action,
        address,
        chain:       chain ?? null,
        tx_hash:     txHash ?? null,
        block_number: blockNumber ?? null,
        gas_params:  gasParams ?? null,
        worker_id:   workerId,
        ts:          new Date().toISOString(),
        ...metadata,
      },
    })
  } catch (err) {
    log.warn('audit', 'Failed to persist signing audit event', { error: err.message, action })
  }
}

// ─── Audit trail reader ───────────────────────────────────────────────────────

/**
 * Fetch the full signing audit trail for an intent.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} intentId
 * @returns {Promise<object[]>}
 */
export async function getAuditTrail(supabase, intentId) {
  const { data, error } = await supabase
    .from('mint_execution_events')
    .select('id, state, message, metadata, created_at')
    .eq('intent_id', intentId)
    .eq('state', 'signing_audit')
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}
