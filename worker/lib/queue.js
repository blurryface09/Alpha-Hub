/**
 * Intent queue state machine.
 * Manages state transitions, atomic claims, and DB persistence.
 */

import { createLogger } from './logger.js'
import { PREWARM_WINDOW_MS } from './timing.js'

const log = createLogger(null, null)

// ─── State constants ──────────────────────────────────────────────────────────

export const INTENT_STATES = {
  PENDING:            'pending',
  ARMED:              'armed',
  QUEUED:             'queued',
  EXECUTING:          'executing',
  EXECUTING_SIM:      'executing_simulation',
  EXECUTING_TESTNET:  'executing_testnet',
  RETRYING:           'retrying',
  SUCCESS:            'success',
  FAILED:             'failed',
  SIM_SUCCESS:        'simulated_success',
  SIM_FAILED:         'simulated_failure',
  TESTNET_SUCCESS:    'testnet_success',
  TESTNET_FAILED:     'testnet_failed',
  EXPIRED:            'expired',
  CANCELLED:          'cancelled',
}

// ─── Valid transitions ────────────────────────────────────────────────────────

/**
 * Allowed state transitions.
 * Key: from-state, Value: Set of valid to-states.
 * @type {Map<string, Set<string>>}
 */
const TRANSITIONS = new Map([
  [INTENT_STATES.PENDING,           new Set([INTENT_STATES.ARMED, INTENT_STATES.SUCCESS, INTENT_STATES.FAILED, INTENT_STATES.CANCELLED, INTENT_STATES.EXPIRED])],
  [INTENT_STATES.ARMED,             new Set([INTENT_STATES.QUEUED, INTENT_STATES.EXECUTING, INTENT_STATES.EXECUTING_SIM, INTENT_STATES.CANCELLED, INTENT_STATES.EXPIRED])],
  [INTENT_STATES.QUEUED,            new Set([INTENT_STATES.EXECUTING, INTENT_STATES.CANCELLED, INTENT_STATES.EXPIRED])],
  [INTENT_STATES.EXECUTING,         new Set([INTENT_STATES.PENDING, INTENT_STATES.SUCCESS, INTENT_STATES.FAILED, INTENT_STATES.RETRYING, INTENT_STATES.ARMED])],
  [INTENT_STATES.EXECUTING_SIM,     new Set([INTENT_STATES.SIM_SUCCESS, INTENT_STATES.SIM_FAILED, INTENT_STATES.ARMED])],
  [INTENT_STATES.EXECUTING_TESTNET, new Set([INTENT_STATES.TESTNET_SUCCESS, INTENT_STATES.TESTNET_FAILED])],
  [INTENT_STATES.RETRYING,          new Set([INTENT_STATES.EXECUTING, INTENT_STATES.FAILED])],
  [INTENT_STATES.FAILED,            new Set([INTENT_STATES.CANCELLED, INTENT_STATES.ARMED])],
  [INTENT_STATES.SIM_FAILED,        new Set([INTENT_STATES.ARMED, INTENT_STATES.CANCELLED])],
  [INTENT_STATES.SIM_SUCCESS,       new Set([INTENT_STATES.ARMED, INTENT_STATES.EXECUTING_TESTNET, INTENT_STATES.CANCELLED])],
  [INTENT_STATES.TESTNET_FAILED,    new Set([INTENT_STATES.SIM_SUCCESS, INTENT_STATES.CANCELLED])],
  [INTENT_STATES.TESTNET_SUCCESS,   new Set([INTENT_STATES.CANCELLED])],
  // Terminal states — empty Set rejects all transitions
  [INTENT_STATES.SUCCESS,           new Set()],
  [INTENT_STATES.CANCELLED,         new Set()],
  [INTENT_STATES.EXPIRED,           new Set()],
])

/** States that the worker can atomically claim for execution */
const CLAIMABLE_STATES = [
  INTENT_STATES.ARMED,
  // Legacy statuses that existed before this state machine was introduced
  'watching',
  'prepared',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString()
}

async function insertEvent(supabase, intent, state, message, metadata = {}) {
  await supabase
    .from('mint_execution_events')
    .insert({
      intent_id: intent.id,
      user_id: intent.user_id,
      state,
      message,
      metadata,
    })
    .throwOnError()
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Atomically claim an intent for execution.
 * Updates status to 'executing' only if the intent is currently in a claimable
 * state AND strike_enabled=true. Returns the updated row, or null if the claim
 * raced with another worker.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} intentId
 * @returns {Promise<object|null>}
 */
export async function claimIntent(supabase, intentId) {
  const intentLog = createLogger(intentId, null)
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status: INTENT_STATES.EXECUTING,
      last_state: 'Strike worker: preparing execution',
      updated_at: now(),
    })
    .eq('id', intentId)
    .eq('strike_enabled', true)
    .in('status', CLAIMABLE_STATES)
    .select()
    .single()

  if (error || !data) {
    intentLog.warn('claim', 'Failed to claim intent (already claimed or wrong state)', {
      intent_id: intentId,
      error: error?.message,
    })
    return null
  }

  intentLog.info('claim', 'Intent claimed for execution', { status: data.status })
  return data
}

/**
 * Transition an intent to a new state, validating the transition first.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} intentId
 * @param {string} fromState  — current state (used for validation only)
 * @param {string} toState
 * @param {Record<string,unknown>} [patch]  — additional fields to update
 * @returns {Promise<object>}
 */
export async function transitionIntent(supabase, intentId, fromState, toState, patch = {}) {
  const intentLog = createLogger(intentId, null)

  const allowed = TRANSITIONS.get(fromState)
  if (!allowed || !allowed.has(toState)) {
    throw new Error(
      `Invalid intent state transition: ${fromState} → ${toState} (intent: ${intentId})`,
    )
  }

  // DATALOSS-1: include fromState in the WHERE clause so the SQL UPDATE is atomic.
  // If two concurrent workers both pass the JS validation above, only one will find
  // a row matching (id AND status=fromState) — the other gets 0 rows back and throws.
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status: toState,
      updated_at: now(),
      ...patch,
    })
    .eq('id', intentId)
    .eq('status', fromState)
    .select()
    .single()

  if (error) throw error

  // If the row no longer has fromState (another worker already transitioned it),
  // Supabase returns null data with no error when using .single() on 0 rows.
  if (!data) {
    throw new Error(
      `Stale transition: intent ${intentId} was no longer in state '${fromState}' — another worker may have already transitioned it`,
    )
  }

  intentLog.info('tick', `Intent transitioned: ${fromState} → ${toState}`, {
    from_state: fromState,
    to_state: toState,
  })
  return data
}

/**
 * Mark an intent as expired, inserting an execution event.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} intent
 */
export async function markExpired(supabase, intent) {
  const intentLog = createLogger(intent.id, intent.user_id)
  try {
    await supabase
      .from('mint_intents')
      .update({
        status: INTENT_STATES.EXPIRED,
        strike_enabled: false,
        last_state: 'Intent expired without execution',
        updated_at: now(),
      })
      .eq('id', intent.id)
      .throwOnError()

    await insertEvent(
      supabase,
      intent,
      INTENT_STATES.EXPIRED,
      'Intent passed expiry window without being executed.',
      { expire_time: now() },
    )
    intentLog.info('expired', 'Intent marked as expired')
  } catch (err) {
    intentLog.error('expired', 'Failed to mark intent as expired', { error: err.message })
  }
}

/**
 * Fetch intents that are ready to execute right now.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} batchSize
 * @param {number} nowMs
 * @returns {Promise<object[]>}
 */
// SCALE-3: Explicit column list avoids shipping unused columns over the wire
// on every 2-second poll tick. Update this list if executor/prewarmer read new fields.
const INTENT_COLUMNS = [
  'id', 'user_id', 'status', 'updated_at', 'strike_enabled',
  'chain', 'contract_address', 'mint_contract_address', 'wallet_address', 'vault_wallet_id',
  'call_data', 'gas_limit', 'gas_strategy', 'strike_execute_at',
  'function_name',
  // NOTE: function_source omitted — column does not exist in DB schema yet.
  // Add via: ALTER TABLE public.mint_intents ADD COLUMN IF NOT EXISTS function_source text;
  'quantity', 'mint_price', 'max_mint_price', 'max_total_spend',
  'project_name',
].join(',')

export async function fetchReadyIntents(supabase, batchSize, nowMs) {
  const nowIso = new Date(nowMs).toISOString()
  const { data, error } = await supabase
    .from('mint_intents')
    .select(INTENT_COLUMNS)
    .eq('strike_enabled', true)
    .in('status', CLAIMABLE_STATES)
    .or(`strike_execute_at.is.null,strike_execute_at.lte.${nowIso}`)
    .order('updated_at', { ascending: true })
    .limit(batchSize)

  if (error) throw error
  return data ?? []
}

/**
 * Fetch intents that are approaching their execution time (prewarm phase).
 * These intents have a strike_execute_at set within the next prewarmWindowMs.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} prewarmWindowMs
 * @param {number} nowMs
 * @returns {Promise<object[]>}
 */
export async function fetchPrewarmIntents(supabase, prewarmWindowMs, nowMs) {
  const nowIso = new Date(nowMs).toISOString()
  const prewarmCutoff = new Date(nowMs + prewarmWindowMs).toISOString()

  const { data, error } = await supabase
    .from('mint_intents')
    .select(INTENT_COLUMNS)
    .eq('strike_enabled', true)
    .in('status', CLAIMABLE_STATES)
    .gt('strike_execute_at', nowIso)
    .lte('strike_execute_at', prewarmCutoff)
    .order('strike_execute_at', { ascending: true })
    .limit(20)

  if (error) throw error
  return data ?? []
}

/**
 * Atomically claim an intent for simulation execution.
 * Transitions armed → executing_simulation only when strike_enabled=true.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} intentId
 * @returns {Promise<object|null>}
 */
export async function claimForSimulation(supabase, intentId) {
  const intentLog = createLogger(intentId, null)
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status: INTENT_STATES.EXECUTING_SIM,
      last_state: 'Strike worker: running simulation',
      updated_at: now(),
    })
    .eq('id', intentId)
    .eq('strike_enabled', true)
    .in('status', CLAIMABLE_STATES)
    .select()
    .single()

  if (error || !data) {
    intentLog.warn('sim_claim', 'Failed to claim intent for simulation', {
      intent_id: intentId,
      error: error?.message,
    })
    return null
  }

  intentLog.info('sim_claim', 'Intent claimed for simulation', { status: data.status })
  return data
}

/**
 * Fetch intents in simulated_failure state that are eligible for requeue.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} batchSize
 * @returns {Promise<object[]>}
 */
export async function fetchSimFailedIntents(supabase, batchSize = 5) {
  const { data, error } = await supabase
    .from('mint_intents')
    .select(INTENT_COLUMNS)
    .eq('strike_enabled', true)
    .eq('status', INTENT_STATES.SIM_FAILED)
    .order('updated_at', { ascending: true })
    .limit(batchSize)

  if (error) throw error
  return data ?? []
}

/**
 * Requeue a simulated_failure intent back to armed for re-simulation.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} intent
 */
export async function requeueForSimulation(supabase, intent) {
  const attemptCount = (intent.sim_requeue_count ?? 0) + 1
  await transitionIntent(supabase, intent.id, INTENT_STATES.SIM_FAILED, INTENT_STATES.ARMED, {
    last_state: `Requeued for re-simulation (attempt ${attemptCount})`,
  })

  await insertEvent(
    supabase,
    intent,
    INTENT_STATES.ARMED,
    `Re-queued for simulation. Attempt ${attemptCount}.`,
    { requeue_count: attemptCount },
  )
}

/**
 * Atomically claim a simulated_success intent for testnet execution.
 * Transitions simulated_success → executing_testnet only if strike_enabled=true.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} intentId
 * @returns {Promise<object|null>}
 */
export async function claimForTestnet(supabase, intentId) {
  const intentLog = createLogger(intentId, null)
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status:     INTENT_STATES.EXECUTING_TESTNET,
      last_state: 'Strike worker: running testnet execution',
      updated_at: now(),
    })
    .eq('id', intentId)
    .eq('strike_enabled', true)
    .eq('status', INTENT_STATES.SIM_SUCCESS)
    .select()
    .single()

  if (error || !data) {
    intentLog.warn('testnet_claim', 'Failed to claim intent for testnet (already claimed or wrong state)', {
      intent_id: intentId,
      error: error?.message,
    })
    return null
  }

  intentLog.info('testnet_claim', 'Intent claimed for testnet execution', { status: data.status })
  return data
}

/**
 * Fetch intents in simulated_success state that are ready for testnet execution.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} batchSize
 * @returns {Promise<object[]>}
 */
export async function fetchTestnetReadyIntents(supabase, batchSize = 3) {
  const { data, error } = await supabase
    .from('mint_intents')
    .select(INTENT_COLUMNS)
    .eq('strike_enabled', true)
    .eq('status', INTENT_STATES.SIM_SUCCESS)
    .order('updated_at', { ascending: true })
    .limit(batchSize)

  if (error) throw error
  return data ?? []
}

/**
 * Fetch intents in testnet_failed state that can be retried.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} batchSize
 * @returns {Promise<object[]>}
 */
export async function fetchTestnetFailedIntents(supabase, batchSize = 5) {
  const { data, error } = await supabase
    .from('mint_intents')
    .select(INTENT_COLUMNS)
    .eq('strike_enabled', true)
    .eq('status', INTENT_STATES.TESTNET_FAILED)
    .order('updated_at', { ascending: true })
    .limit(batchSize)

  if (error) throw error
  return data ?? []
}
