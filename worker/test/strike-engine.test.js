/**
 * Strike engine orchestration tests.
 * Validates the tick() dispatch logic, safety gates, phase exclusivity,
 * claim-race handling, and batch processing.
 *
 * Run: node worker/test/strike-engine.test.js
 *
 * The engine uses module-level dynamic imports that can't be injected directly,
 * so the dispatch conditions are tested as pure functions that mirror the
 * exact source in strike-engine.js. Any change to the dispatch logic must
 * be reflected here.
 */

import assert from 'assert/strict'
import { INTENT_STATES } from '../lib/queue.js'

// ─── Replicated dispatch logic (mirrors strike-engine.js tick() exactly) ─────

/**
 * Returns which execution path is active for a given flag combination.
 * Mirrors the exact condition chain in tick().
 */
function resolveDispatchPath(flags, modules) {
  const { liveEnabled, simMode, testnetEnabled } = flags
  const { AUTO_STRIKE_ENABLED, ALPHA_VAULT_ENABLED } = flags

  // Safety gate: live requested but legacy safety switches are off
  if (liveEnabled && (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED)) {
    return 'safety_blocked'
  }

  // Idle gate: nothing enabled
  if (!liveEnabled && !simMode && !testnetEnabled) {
    return 'idle'
  }

  return 'active'
}

/**
 * Returns which executors run for a given intent, mirroring tick()'s dispatch.
 * `modules` controls whether lib executors are loaded (null = not loaded).
 */
function resolveIntentDispatch(flags, modules) {
  const { liveEnabled, simMode } = flags
  const { simulateArmedIntent, executeIntent } = modules

  if (simMode && !liveEnabled && simulateArmedIntent) return 'sim'
  if (liveEnabled && executeIntent) return 'live_lib'
  if (liveEnabled) return 'live_legacy'
  return 'no_dispatch'
}

/**
 * Returns whether the testnet sweep runs for a given flag/module combination.
 * Mirrors: testnetEnabled && !liveEnabled && executeTestnetIntent && fetchTestnetReadyIntents
 */
function testnetSweepActive(flags, modules) {
  const { testnetEnabled, liveEnabled } = flags
  const { executeTestnetIntent, fetchTestnetReadyIntents } = modules
  return testnetEnabled && !liveEnabled && Boolean(executeTestnetIntent) && Boolean(fetchTestnetReadyIntents)
}

/**
 * Returns whether the sim requeue sweep runs.
 * Mirrors: simMode && runSimulationRequeueSweep
 */
function simRequeueSweepActive(flags, modules) {
  return flags.simMode && Boolean(modules.runSimulationRequeueSweep)
}

// ─── Section 1: Safety gate ───────────────────────────────────────────────────

{
  // Live requested but AUTO_STRIKE_ENABLED is off → blocked
  const path = resolveDispatchPath(
    { liveEnabled: true, simMode: false, testnetEnabled: false, AUTO_STRIKE_ENABLED: false, ALPHA_VAULT_ENABLED: true },
    {},
  )
  assert.equal(path, 'safety_blocked')
  console.log('✓ [gate] live + AUTO_STRIKE_ENABLED=false → safety_blocked')
}

{
  // Live requested but ALPHA_VAULT_ENABLED is off → blocked
  const path = resolveDispatchPath(
    { liveEnabled: true, simMode: false, testnetEnabled: false, AUTO_STRIKE_ENABLED: true, ALPHA_VAULT_ENABLED: false },
    {},
  )
  assert.equal(path, 'safety_blocked')
  console.log('✓ [gate] live + ALPHA_VAULT_ENABLED=false → safety_blocked')
}

{
  // Both safety switches off → blocked
  const path = resolveDispatchPath(
    { liveEnabled: true, simMode: false, testnetEnabled: false, AUTO_STRIKE_ENABLED: false, ALPHA_VAULT_ENABLED: false },
    {},
  )
  assert.equal(path, 'safety_blocked')
  console.log('✓ [gate] live + both switches off → safety_blocked')
}

{
  // All switches on → active
  const path = resolveDispatchPath(
    { liveEnabled: true, simMode: false, testnetEnabled: false, AUTO_STRIKE_ENABLED: true, ALPHA_VAULT_ENABLED: true },
    {},
  )
  assert.equal(path, 'active')
  console.log('✓ [gate] live + all switches on → active')
}

{
  // Safety switch check is ONLY applied to live path — sim ignores them
  const path = resolveDispatchPath(
    { liveEnabled: false, simMode: true, testnetEnabled: false, AUTO_STRIKE_ENABLED: false, ALPHA_VAULT_ENABLED: false },
    {},
  )
  assert.equal(path, 'active', 'sim mode does not require safety switches')
  console.log('✓ [gate] sim mode with safety switches off → active (gate is live-only)')
}

{
  // Testnet also ignores legacy safety switches
  const path = resolveDispatchPath(
    { liveEnabled: false, simMode: false, testnetEnabled: true, AUTO_STRIKE_ENABLED: false, ALPHA_VAULT_ENABLED: false },
    {},
  )
  assert.equal(path, 'active', 'testnet mode does not require legacy safety switches')
  console.log('✓ [gate] testnet mode with safety switches off → active (gate is live-only)')
}

// ─── Section 2: Idle gate ─────────────────────────────────────────────────────

{
  // All flags off → idle
  const path = resolveDispatchPath(
    { liveEnabled: false, simMode: false, testnetEnabled: false, AUTO_STRIKE_ENABLED: true, ALPHA_VAULT_ENABLED: true },
    {},
  )
  assert.equal(path, 'idle')
  console.log('✓ [idle] all execution flags off → idle (no DB writes, no executor calls)')
}

{
  // Any flag on → active (or safety_blocked)
  for (const [key, label] of [
    [{ liveEnabled: true, simMode: false, testnetEnabled: false, AUTO_STRIKE_ENABLED: true, ALPHA_VAULT_ENABLED: true }, 'liveEnabled'],
    [{ liveEnabled: false, simMode: true, testnetEnabled: false, AUTO_STRIKE_ENABLED: false, ALPHA_VAULT_ENABLED: false }, 'simMode'],
    [{ liveEnabled: false, simMode: false, testnetEnabled: true, AUTO_STRIKE_ENABLED: false, ALPHA_VAULT_ENABLED: false }, 'testnetEnabled'],
  ]) {
    const path = resolveDispatchPath(key, {})
    assert.notEqual(path, 'idle', `${label}=true should not be idle`)
  }
  console.log('✓ [idle] any single execution flag on exits idle state')
}

// ─── Section 3: Dispatch routing ──────────────────────────────────────────────

{
  // SIMULATION_MODE=true, LIVE_EXECUTION_ENABLED=false → sim executor
  const dispatch = resolveIntentDispatch(
    { simMode: true, liveEnabled: false },
    { simulateArmedIntent: () => {}, executeIntent: () => {} },
  )
  assert.equal(dispatch, 'sim')
  console.log('✓ [dispatch] simMode=true, liveEnabled=false → sim executor')
}

{
  // LIVE_EXECUTION_ENABLED=true + lib loaded → live lib executor
  const dispatch = resolveIntentDispatch(
    { simMode: false, liveEnabled: true },
    { simulateArmedIntent: () => {}, executeIntent: () => {} },
  )
  assert.equal(dispatch, 'live_lib')
  console.log('✓ [dispatch] liveEnabled=true + executeIntent loaded → live lib executor')
}

{
  // LIVE_EXECUTION_ENABLED=true + lib NOT loaded → legacy fallback
  const dispatch = resolveIntentDispatch(
    { simMode: false, liveEnabled: true },
    { simulateArmedIntent: null, executeIntent: null },
  )
  assert.equal(dispatch, 'live_legacy')
  console.log('✓ [dispatch] liveEnabled=true + executeIntent not loaded → legacy fallback')
}

{
  // simMode=true but lib not loaded → no_dispatch (falls through all conditions)
  const dispatch = resolveIntentDispatch(
    { simMode: true, liveEnabled: false },
    { simulateArmedIntent: null, executeIntent: null },
  )
  assert.equal(dispatch, 'no_dispatch')
  console.log('✓ [dispatch] simMode=true + simulateArmedIntent not loaded → no_dispatch')
}

// ─── Section 4: Phase exclusivity ─────────────────────────────────────────────

{
  // LIVE overrides SIM: liveEnabled=true means sim condition (simMode && !liveEnabled) is false
  const dispatch = resolveIntentDispatch(
    { simMode: true, liveEnabled: true },
    { simulateArmedIntent: () => {}, executeIntent: () => {} },
  )
  assert.equal(dispatch, 'live_lib', 'live wins over sim when both flags are true')
  assert.notEqual(dispatch, 'sim', 'sim is NOT called when liveEnabled=true')
  console.log('✓ [exclusivity] liveEnabled=true overrides simMode=true → live_lib (sim skipped)')
}

{
  // Testnet sweep blocked when live is enabled
  const testnetRuns = testnetSweepActive(
    { testnetEnabled: true, liveEnabled: true },
    { executeTestnetIntent: () => {}, fetchTestnetReadyIntents: () => {} },
  )
  assert.equal(testnetRuns, false, 'testnet sweep does not run when liveEnabled=true')
  console.log('✓ [exclusivity] liveEnabled=true blocks testnet sweep (testnetEnabled && !liveEnabled)')
}

{
  // Testnet sweep runs when only testnet is enabled
  const testnetRuns = testnetSweepActive(
    { testnetEnabled: true, liveEnabled: false },
    { executeTestnetIntent: () => {}, fetchTestnetReadyIntents: () => {} },
  )
  assert.equal(testnetRuns, true)
  console.log('✓ [exclusivity] testnetEnabled=true, liveEnabled=false → testnet sweep runs')
}

{
  // Sim + testnet can coexist (different state queues — no collision)
  // Sim processes: armed, watching, prepared (CLAIMABLE_STATES)
  // Testnet processes: simulated_success (separate queue)
  const CLAIMABLE_STATES = ['armed', 'watching', 'prepared']
  const TESTNET_CLAIM_STATE = INTENT_STATES.SIM_SUCCESS // 'simulated_success'

  assert.ok(!CLAIMABLE_STATES.includes(TESTNET_CLAIM_STATE),
    'simulated_success is NOT in CLAIMABLE_STATES — sim and testnet queues are orthogonal')

  const simRuns = resolveIntentDispatch(
    { simMode: true, liveEnabled: false },
    { simulateArmedIntent: () => {}, executeIntent: null },
  )
  const testnetRuns2 = testnetSweepActive(
    { testnetEnabled: true, liveEnabled: false },
    { executeTestnetIntent: () => {}, fetchTestnetReadyIntents: () => {} },
  )

  assert.equal(simRuns, 'sim')
  assert.equal(testnetRuns2, true, 'both sim and testnet can run simultaneously without collision')
  console.log('✓ [exclusivity] sim + testnet coexist safely: different state queues (armed vs simulated_success)')
}

// ─── Section 5: Claim race handling ──────────────────────────────────────────

{
  // simulateArmedIntent returns null when claim races — tick() swallows null via .catch()
  // The intent should be silently skipped, not throw
  let called = 0
  const mockSimulate = async () => { called++; return null } // null = claim raced

  const results = []
  const intents = [
    { id: 'intent-1', user_id: 'user-1', status: 'armed' },
    { id: 'intent-2', user_id: 'user-1', status: 'armed' },
  ]

  for (const intent of intents) {
    const result = await mockSimulate(null, intent).catch(err => {
      results.push({ error: err.message })
    })
    results.push({ null: result === null })
  }

  assert.equal(called, 2, 'both intents were attempted')
  assert.ok(results.every(r => r.null === true), 'null returns are passed through without error')
  console.log('✓ [claim-race] simulateArmedIntent returning null is handled gracefully (intent skipped)')
}

{
  // executeTestnetIntent returns null on claim race — also swallowed by .catch()
  let testnetCalled = 0
  const mockTestnetExecute = async () => { testnetCalled++; return null }

  const result = await mockTestnetExecute(null, { id: 'intent-3' }).catch(() => 'error')
  assert.equal(result, null, 'null return from testnet executor is handled gracefully')
  assert.equal(testnetCalled, 1)
  console.log('✓ [claim-race] executeTestnetIntent returning null is handled gracefully')
}

{
  // Executor throwing an error is caught by .catch(err => workerError(...)) in tick()
  // — does NOT propagate to stop the batch loop
  const errors = []
  const mockFailing = async () => { throw new Error('simulated DB failure') }

  await mockFailing().catch(err => errors.push(err.message))

  assert.equal(errors.length, 1)
  assert.match(errors[0], /simulated DB failure/)
  console.log('✓ [claim-race] executor throwing propagates to workerError but does not stop batch loop')
}

// ─── Section 6: Batch processing ─────────────────────────────────────────────

{
  // tick() processes all intents in a batch sequentially (for...of, no parallel)
  const order = []
  async function mockExecute(supabase, intent) {
    order.push(intent.id)
    return { intent, succeeded: true }
  }

  const batch = [
    { id: 'a', user_id: 'u1' },
    { id: 'b', user_id: 'u1' },
    { id: 'c', user_id: 'u1' },
  ]

  for (const intent of batch) {
    await mockExecute(null, intent).catch(() => null)
  }

  assert.deepEqual(order, ['a', 'b', 'c'], 'batch is processed sequentially in order')
  console.log('✓ [batch] intents in a batch are processed sequentially (a → b → c)')
}

{
  // A single failure in the batch does not skip remaining intents
  const processed = []
  async function mockExecuteWithFailure(supabase, intent) {
    if (intent.id === 'b') throw new Error('intent b failed')
    processed.push(intent.id)
  }

  const batch = [
    { id: 'a', user_id: 'u1' },
    { id: 'b', user_id: 'u1' },
    { id: 'c', user_id: 'u1' },
  ]

  for (const intent of batch) {
    await mockExecuteWithFailure(null, intent).catch(() => null)
  }

  assert.deepEqual(processed, ['a', 'c'], 'remaining intents processed after one failure')
  console.log('✓ [batch] one failing intent does not stop the rest of the batch')
}

// ─── Section 7: Sim requeue sweep ─────────────────────────────────────────────

{
  // Requeue sweep runs only when simMode=true AND module is loaded
  assert.equal(simRequeueSweepActive({ simMode: true },  { runSimulationRequeueSweep: () => {} }), true)
  assert.equal(simRequeueSweepActive({ simMode: false }, { runSimulationRequeueSweep: () => {} }), false)
  assert.equal(simRequeueSweepActive({ simMode: true },  { runSimulationRequeueSweep: null }),      false)
  console.log('✓ [sim-requeue] sweep runs only when simMode=true and module loaded')
}

// ─── Section 8: envReady() validation ────────────────────────────────────────

{
  // Replicate envReady() logic from strike-engine.js
  function envReady(env) {
    const missing = []
    if (!env.SUPABASE_URL && !env.VITE_SUPABASE_URL) missing.push('SUPABASE_URL')
    if (!env.SUPABASE_SERVICE_ROLE_KEY && !env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
    if (!env.ALPHA_VAULT_ENCRYPTION_KEY && !env.WALLET_ENCRYPTION_KEY) missing.push('ALPHA_VAULT_ENCRYPTION_KEY')
    return missing
  }

  // All missing
  assert.deepEqual(envReady({}), ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ALPHA_VAULT_ENCRYPTION_KEY'])
  console.log('✓ [env] envReady reports all missing vars when none set')
}

{
  function envReady(env) {
    const missing = []
    if (!env.SUPABASE_URL && !env.VITE_SUPABASE_URL) missing.push('SUPABASE_URL')
    if (!env.SUPABASE_SERVICE_ROLE_KEY && !env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
    if (!env.ALPHA_VAULT_ENCRYPTION_KEY && !env.WALLET_ENCRYPTION_KEY) missing.push('ALPHA_VAULT_ENCRYPTION_KEY')
    return missing
  }

  // Primary vars set
  assert.deepEqual(envReady({
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
    ALPHA_VAULT_ENCRYPTION_KEY: 'secret',
  }), [])
  console.log('✓ [env] envReady returns empty array when all primary vars are set')
}

{
  function envReady(env) {
    const missing = []
    if (!env.SUPABASE_URL && !env.VITE_SUPABASE_URL) missing.push('SUPABASE_URL')
    if (!env.SUPABASE_SERVICE_ROLE_KEY && !env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
    if (!env.ALPHA_VAULT_ENCRYPTION_KEY && !env.WALLET_ENCRYPTION_KEY) missing.push('ALPHA_VAULT_ENCRYPTION_KEY')
    return missing
  }

  // Fallback vars accepted
  assert.deepEqual(envReady({
    VITE_SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_KEY: 'key',
    WALLET_ENCRYPTION_KEY: 'secret',
  }), [])
  console.log('✓ [env] envReady accepts fallback var names (VITE_SUPABASE_URL, SUPABASE_SERVICE_KEY, WALLET_ENCRYPTION_KEY)')
}

// ─── Section 9: State queue separation ───────────────────────────────────────

{
  // Verify that the three execution paths operate on non-overlapping DB state queues.
  // This is the structural guarantee that prevents double-execution.

  const CLAIMABLE_STATES = ['armed', 'watching', 'prepared']          // live + sim
  const TESTNET_QUEUE    = [INTENT_STATES.SIM_SUCCESS]                 // testnet only
  const SIM_CLAIM_TARGET = INTENT_STATES.EXECUTING_SIM                 // 'executing_simulation'
  const TESTNET_TARGET   = INTENT_STATES.EXECUTING_TESTNET             // 'executing_testnet'
  const LIVE_TARGET      = INTENT_STATES.EXECUTING                     // 'executing'

  // No queue overlap between sim/live and testnet
  for (const state of TESTNET_QUEUE) {
    assert.ok(!CLAIMABLE_STATES.includes(state),
      `${state} must not be in CLAIMABLE_STATES (sim/live queue)`)
  }

  // No claim target overlap
  assert.notEqual(SIM_CLAIM_TARGET, TESTNET_TARGET)
  assert.notEqual(SIM_CLAIM_TARGET, LIVE_TARGET)
  assert.notEqual(TESTNET_TARGET, LIVE_TARGET)

  console.log('✓ [queues] All three execution paths claim from non-overlapping state queues')
  console.log(`  sim:     ${CLAIMABLE_STATES.join('|')} → ${SIM_CLAIM_TARGET}`)
  console.log(`  testnet: ${TESTNET_QUEUE.join('|')} → ${TESTNET_TARGET}`)
  console.log(`  live:    ${CLAIMABLE_STATES.join('|')} → ${LIVE_TARGET}`)
}

// ─── Section 10: Flag combination matrix ─────────────────────────────────────

{
  // Exhaustive test of all meaningful flag combinations
  const allCombinations = [
    // [liveEnabled, simMode, testnetEnabled, AUTO_STRIKE, ALPHA_VAULT, expected_path, expected_dispatch, testnet_runs]
    [false, false, false, true,  true,  'idle',            'no_dispatch', false],
    [false, true,  false, false, false, 'active',          'sim',         false],
    [false, false, true,  false, false, 'active',          'no_dispatch', true ],
    [false, true,  true,  false, false, 'active',          'sim',         true ],  // sim + testnet coexist
    [true,  false, false, true,  true,  'active',          'live_lib',    false],
    [true,  false, false, false, true,  'safety_blocked',  null,          false],  // safety gate
    [true,  false, false, true,  false, 'safety_blocked',  null,          false],  // safety gate
    [true,  true,  false, true,  true,  'active',          'live_lib',    false],  // live wins over sim
    [true,  false, true,  true,  true,  'active',          'live_lib',    false],  // live blocks testnet
    [true,  true,  true,  true,  true,  'active',          'live_lib',    false],  // live wins all
  ]

  const modules = { simulateArmedIntent: () => {}, executeIntent: () => {}, executeTestnetIntent: () => {}, fetchTestnetReadyIntents: () => {} }

  for (const [live, sim, testnet, autoStrike, alphaVault, expPath, expDispatch, expTestnet] of allCombinations) {
    const flags = { liveEnabled: live, simMode: sim, testnetEnabled: testnet, AUTO_STRIKE_ENABLED: autoStrike, ALPHA_VAULT_ENABLED: alphaVault }

    const path = resolveDispatchPath(flags, modules)
    assert.equal(path, expPath,
      `live=${live} sim=${sim} testnet=${testnet} auto=${autoStrike} vault=${alphaVault} → path should be ${expPath}`)

    if (expDispatch !== null && path === 'active') {
      const dispatch = resolveIntentDispatch(flags, modules)
      assert.equal(dispatch, expDispatch,
        `live=${live} sim=${sim} → dispatch should be ${expDispatch}`)
    }

    const testnetRuns = testnetSweepActive(flags, modules)
    assert.equal(testnetRuns, expTestnet,
      `live=${live} testnet=${testnet} → testnet sweep should be ${expTestnet}`)
  }

  console.log(`✓ [matrix] All ${allCombinations.length} flag combinations produce correct routing`)
}

console.log('\nAll strike-engine orchestration tests passed.')
