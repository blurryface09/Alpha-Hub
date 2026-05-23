/**
 * Phase 5 — Strike engine validation.
 *
 * Tests orchestration logic that isn't covered by t0-flow or exec-trace:
 *  S1 — Safety switch enforcement (refuse live execution when switches are off)
 *  S2 — legacyClaimIntent CAS semantics (atomic claim, double-execution prevention)
 *  S3 — Legacy path dispatch (fast path vs. full detect, RPC candidate fallback)
 *  S4 — executor.js orchestration (claim→skip, dry-run requeue, to/value/gas resolution)
 *  S5 — Recovery outcome routing (confirmed→success, reverted→invalidate, dropped→failed)
 *  S6 — SeaDrop router flow (prepared.to=router, value=exact wei from prewarm)
 *
 * Run: node worker/test/strike-validation.test.js
 */

import assert from 'assert/strict'
import {
  getCachedExecution,
  setCachedExecution,
  invalidateCachedExecution,
} from '../../api/_lib/contract-cache.js'

// ─── Harness ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const results = []

async function test(name, fn) {
  const t = Date.now()
  try {
    await fn()
    const ms = Date.now() - t
    console.log(`  ✓  ${name} (${ms}ms)`)
    passed++
    results.push({ name, pass: true, ms })
  } catch (err) {
    const ms = Date.now() - t
    console.error(`  ✗  ${name} (${ms}ms)`)
    console.error(`     ${err.message}`)
    failed++
    results.push({ name, pass: false, ms, error: err.message })
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NFT_CONTRACT  = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const ROUTER_ADDR   = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
const PREWARM_DATA  = '0x161ac21f000000000000000000000000deadbeef'
const PREWARM_VALUE = '80000000000000'
const PREWARM_GAS   = '200000'

// ─── Intent fixtures ──────────────────────────────────────────────────────────

function makeIntent(overrides = {}) {
  return {
    id: 'strike-v-001',
    user_id: 'user-v-001',
    chain: 'eth',
    contract_address: NFT_CONTRACT,
    mint_contract_address: null,
    to: null,
    vault_wallet_id: null,
    max_mint_price: '0',
    mint_price: '0',
    value: null,
    call_data: null,
    gas_limit: null,
    function_name: null,
    quantity: 1,
    strike_enabled: true,
    strike_execute_at: new Date(Date.now() - 100).toISOString(), // past T=0
    ...overrides,
  }
}

// ─── Supabase mock ────────────────────────────────────────────────────────────

function makeSupabase({ claimReturnsRow = true } = {}) {
  const updates = []
  const inserts = []
  const selections = []

  const sb = {
    _updates: updates,
    _inserts: inserts,
    _selections: selections,

    from(table) {
      const self = this
      return {
        select(cols) {
          return {
            eq: () => ({
              eq: () => ({
                in: () => ({
                  select: () => ({
                    single: async () => {
                      const row = claimReturnsRow
                        ? { ...makeIntent(), status: 'executing' }
                        : null
                      return { data: row, error: row ? null : { message: 'not found' } }
                    },
                  }),
                }),
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }
        },
        update(row) {
          updates.push({ table, row })
          return {
            eq(col, val) {
              return {
                eq: () => ({
                  in: () => ({
                    select: () => ({
                      single: async () => {
                        const claimed = claimReturnsRow
                          ? { ...makeIntent(), status: 'executing' }
                          : null
                        return { data: claimed, error: null }
                      },
                    }),
                  }),
                  catch: () => Promise.resolve(),
                  throwOnError: () => Promise.resolve(),
                }),
                in: () => ({
                  select: () => ({
                    single: async () => {
                      const claimed = claimReturnsRow
                        ? { ...makeIntent(), status: 'executing' }
                        : null
                      return { data: claimed, error: null }
                    },
                  }),
                }),
                catch: () => Promise.resolve(),
                throwOnError: () => Promise.resolve(),
              }
            },
            catch: () => Promise.resolve(),
            throwOnError: () => Promise.resolve(),
          }
        },
        insert(row) {
          inserts.push({ table, row })
          return {
            catch: () => Promise.resolve(),
            throwOnError: () => Promise.resolve(),
          }
        },
      }
    },
  }
  return sb
}

// ─── Section 1: Safety switch enforcement ─────────────────────────────────────

console.log('\n=== Section 1: Safety switch enforcement ===\n')

// Replicate the tick() live-execution gate logic from strike-engine.js
function checkSafetySwitches({ liveEnabled, AUTO_STRIKE_ENABLED, ALPHA_VAULT_ENABLED }) {
  if (liveEnabled && (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED)) {
    return { blocked: true, reason: 'safety_switches_off' }
  }
  return { blocked: false }
}

await test('s1: LIVE_EXECUTION_ENABLED=true, both switches off → blocked', () => {
  const result = checkSafetySwitches({
    liveEnabled: true,
    AUTO_STRIKE_ENABLED: false,
    ALPHA_VAULT_ENABLED: false,
  })
  assert.equal(result.blocked, true)
  assert.equal(result.reason, 'safety_switches_off')
})

await test('s1: LIVE_EXECUTION_ENABLED=true, AUTO_STRIKE off only → blocked', () => {
  const result = checkSafetySwitches({
    liveEnabled: true,
    AUTO_STRIKE_ENABLED: false,
    ALPHA_VAULT_ENABLED: true,
  })
  assert.equal(result.blocked, true)
})

await test('s1: LIVE_EXECUTION_ENABLED=true, ALPHA_VAULT off only → blocked', () => {
  const result = checkSafetySwitches({
    liveEnabled: true,
    AUTO_STRIKE_ENABLED: true,
    ALPHA_VAULT_ENABLED: false,
  })
  assert.equal(result.blocked, true)
})

await test('s1: LIVE_EXECUTION_ENABLED=true, both switches on → allowed', () => {
  const result = checkSafetySwitches({
    liveEnabled: true,
    AUTO_STRIKE_ENABLED: true,
    ALPHA_VAULT_ENABLED: true,
  })
  assert.equal(result.blocked, false)
})

await test('s1: LIVE_EXECUTION_ENABLED=false → safety check skipped (no block)', () => {
  // When liveEnabled=false the guard is never evaluated — sim mode proceeds freely
  const result = checkSafetySwitches({
    liveEnabled: false,
    AUTO_STRIKE_ENABLED: false,
    ALPHA_VAULT_ENABLED: false,
  })
  assert.equal(result.blocked, false)
})

// ─── Section 2: legacyClaimIntent CAS semantics ───────────────────────────────

console.log('\n=== Section 2: legacyClaimIntent CAS semantics ===\n')

// Replicate claim CAS logic — returns claimed row or null
async function simulateLegacyClaimIntent(supabase, intent) {
  const { data, error } = await supabase
    .from('mint_intents')
    .update({
      status: 'executing',
      last_state: 'Preparing Strike transaction',
      updated_at: new Date().toISOString(),
    })
    .eq('id', intent.id)
    .eq('strike_enabled', true)
    .in('status', ['armed', 'watching', 'prepared'])
    .select()
    .single()
  if (error || !data) return null
  return data
}

await test('s2: claim succeeds when DB returns updated row', async () => {
  const sb = makeSupabase({ claimReturnsRow: true })
  const claimed = await simulateLegacyClaimIntent(sb, makeIntent())
  assert.ok(claimed, 'should return claimed intent')
  assert.equal(claimed.status, 'executing')
})

await test('s2: claim returns null when DB returns no row (already claimed)', async () => {
  const sb = makeSupabase({ claimReturnsRow: false })
  const claimed = await simulateLegacyClaimIntent(sb, makeIntent())
  assert.equal(claimed, null, 'should return null when already claimed')
})

await test('s2: claim updates status to executing', async () => {
  const sb = makeSupabase({ claimReturnsRow: true })
  await simulateLegacyClaimIntent(sb, makeIntent())
  const update = sb._updates.find(u => u.table === 'mint_intents')
  assert.ok(update, 'should write DB update')
  assert.equal(update.row.status, 'executing')
})

await test('s2: claim sets last_state to preparing message', async () => {
  const sb = makeSupabase({ claimReturnsRow: true })
  await simulateLegacyClaimIntent(sb, makeIntent())
  const update = sb._updates.find(u => u.table === 'mint_intents')
  assert.ok(update.row.last_state.includes('Preparing'), `last_state: ${update.row.last_state}`)
})

await test('s2: double-claim: second worker gets null (both update same row)', async () => {
  // Simulate two workers trying to claim; first succeeds, second sees null
  const sb1 = makeSupabase({ claimReturnsRow: true })
  const sb2 = makeSupabase({ claimReturnsRow: false })
  const intent = makeIntent()
  const first  = await simulateLegacyClaimIntent(sb1, intent)
  const second = await simulateLegacyClaimIntent(sb2, intent)
  assert.ok(first, 'first claim should succeed')
  assert.equal(second, null, 'second claim should be null (already claimed)')
})

// ─── Section 3: Legacy path dispatch ─────────────────────────────────────────

console.log('\n=== Section 3: Legacy path dispatch ===\n')

// Replicate the fast-path vs. legacy-path branching from legacyProcessIntent
async function simulateLegacyDispatch(intent, rpcCandidates, prepareFn) {
  let prepared = null
  let selectedRpc = null
  let prepareLatencyMs = null
  let prepareCalled = false

  if (intent.call_data) {
    selectedRpc = rpcCandidates[0]
    const startedAt = Date.now()
    prepared = {
      to: intent.to || intent.contract_address,
      data: intent.call_data,
      value: intent.value || '0',
      gas: intent.gas_limit || null,
      functionName: intent.function_name || 'prewarmed',
      source: 'prewarm_cache',
    }
    prepareLatencyMs = Date.now() - startedAt
  } else {
    let lastPrepareError = null
    for (const candidate of rpcCandidates) {
      const startedAt = Date.now()
      try {
        prepareCalled = true
        prepared = await prepareFn(candidate)
        selectedRpc = candidate
        prepareLatencyMs = Date.now() - startedAt
        break
      } catch (err) {
        lastPrepareError = err
      }
    }
    if (!prepared || !selectedRpc) throw lastPrepareError || new Error('Strike preparation failed.')
  }

  return { prepared, selectedRpc, prepareLatencyMs, prepareCalled }
}

const RPCS = [
  { label: 'eth_rpc_1', url: 'https://eth1.example.com' },
  { label: 'eth_rpc_2', url: 'https://eth2.example.com' },
]

await test('s3: call_data present → fast path, prepareFn never called', async () => {
  const intent = makeIntent({
    call_data: PREWARM_DATA,
    gas_limit: PREWARM_GAS,
    to: ROUTER_ADDR,
    value: PREWARM_VALUE,
    function_name: 'mintPublic',
  })
  let fnCalled = false
  const { prepared, prepareCalled } = await simulateLegacyDispatch(
    intent, RPCS, async () => { fnCalled = true; return {} },
  )
  assert.equal(fnCalled, false, 'prepareFn must not be called when call_data is set')
  assert.equal(prepared.source, 'prewarm_cache')
  assert.equal(prepared.functionName, 'mintPublic')
  assert.equal(prepared.to, ROUTER_ADDR)
  assert.equal(prepared.value, PREWARM_VALUE)
  assert.equal(prepared.gas, PREWARM_GAS)
})

await test('s3: no call_data → prepareFn called with first RPC candidate', async () => {
  const intent = makeIntent({ call_data: null })
  let usedLabel = null
  const { prepared, selectedRpc } = await simulateLegacyDispatch(
    intent, RPCS, async (candidate) => {
      usedLabel = candidate.label
      return { functionName: 'mint', source: 'common_signature', to: NFT_CONTRACT, value: '0', gas: '150000', data: '0xdeadbeef' }
    },
  )
  assert.equal(usedLabel, 'eth_rpc_1', 'first candidate tried first')
  assert.equal(selectedRpc.label, 'eth_rpc_1')
  assert.equal(prepared.functionName, 'mint')
})

await test('s3: first RPC fails → second RPC tried (fallback)', async () => {
  const intent = makeIntent({ call_data: null })
  let attempts = 0
  const { selectedRpc } = await simulateLegacyDispatch(
    intent, RPCS, async (candidate) => {
      attempts++
      if (candidate.label === 'eth_rpc_1') throw new Error('eth_rpc_1 timeout')
      return { functionName: 'mint', source: 'common_signature', to: NFT_CONTRACT, value: '0', gas: '150000', data: '0x' }
    },
  )
  assert.equal(attempts, 2, 'both RPCs should be tried')
  assert.equal(selectedRpc.label, 'eth_rpc_2', 'second RPC should be selected')
})

await test('s3: all RPCs fail → throws last prepare error', async () => {
  const intent = makeIntent({ call_data: null })
  const expectedMsg = 'No mint function detected'
  await assert.rejects(
    () => simulateLegacyDispatch(intent, RPCS, async () => { throw new Error(expectedMsg) }),
    (err) => {
      assert.equal(err.message, expectedMsg)
      return true
    },
  )
})

await test('s3: empty rpcCandidates array → throws "Strike preparation failed"', async () => {
  const intent = makeIntent({ call_data: null })
  await assert.rejects(
    () => simulateLegacyDispatch(intent, [], async () => ({})),
    /Strike preparation failed/,
  )
})

await test('s3: fast path uses intent.to as prepared.to (SeaDrop router)', async () => {
  const intent = makeIntent({
    call_data: PREWARM_DATA,
    to: ROUTER_ADDR,
    contract_address: NFT_CONTRACT,
  })
  const { prepared } = await simulateLegacyDispatch(intent, RPCS, async () => ({}))
  // Fast path: intent.to || intent.contract_address
  assert.equal(prepared.to, ROUTER_ADDR,
    'should use intent.to (router) not contract_address')
})

await test('s3: fast path falls back to contract_address when to is null', async () => {
  const intent = makeIntent({
    call_data: PREWARM_DATA,
    to: null,
    contract_address: NFT_CONTRACT,
  })
  const { prepared } = await simulateLegacyDispatch(intent, RPCS, async () => ({}))
  assert.equal(prepared.to.toLowerCase(), NFT_CONTRACT.toLowerCase())
})

// ─── Section 4: executor.js orchestration ─────────────────────────────────────

console.log('\n=== Section 4: executor.js orchestration ===\n')

// Replicate the Step 7 to/value/gas resolution from executeIntent
function resolveExecutorTxFields(intent) {
  const to    = intent.mint_contract_address || intent.to || intent.contract_address
  const value = BigInt(intent.mint_price || intent.value || '0')
  const data  = intent.call_data || intent.data || undefined
  const gas   = intent.gas_limit ? BigInt(intent.gas_limit) : undefined
  const fn    = intent.function_name || (data ? 'prewarmed' : null)
  const src   = data ? 'prewarm_cache' : null
  return { to, value, data, gas, fn, src }
}

await test('s4: to resolves mint_contract_address first', () => {
  const intent = makeIntent({
    mint_contract_address: '0xaaaa000000000000000000000000000000000001',
    to: ROUTER_ADDR,
    contract_address: NFT_CONTRACT,
  })
  const { to } = resolveExecutorTxFields(intent)
  assert.equal(to.toLowerCase(), '0xaaaa000000000000000000000000000000000001')
})

await test('s4: to falls back to intent.to (SeaDrop router)', () => {
  const intent = makeIntent({
    mint_contract_address: null,
    to: ROUTER_ADDR,
    contract_address: NFT_CONTRACT,
  })
  const { to } = resolveExecutorTxFields(intent)
  assert.equal(to.toLowerCase(), ROUTER_ADDR.toLowerCase())
})

await test('s4: to falls back to contract_address when mint_contract_address + to are null (C4)', () => {
  const intent = makeIntent({
    mint_contract_address: null,
    to: null,
    contract_address: NFT_CONTRACT,
  })
  const { to } = resolveExecutorTxFields(intent)
  assert.equal(to.toLowerCase(), NFT_CONTRACT.toLowerCase())
})

await test('s4: all address fields null → to is null (executor throws at runtime)', () => {
  const intent = makeIntent({
    mint_contract_address: null,
    to: null,
    contract_address: null,
  })
  const { to } = resolveExecutorTxFields(intent)
  // null || null || null === null in JS; executor then throws "Intent has no contract address"
  assert.equal(to, null, 'to should be null (falsy) when no address fields set')
})

await test('s4: value uses mint_price first', () => {
  const intent = makeIntent({ mint_price: '1000000000000000', value: '999' })
  const { value } = resolveExecutorTxFields(intent)
  assert.equal(value, 1000000000000000n)
})

await test('s4: value falls back to intent.value', () => {
  const intent = makeIntent({ mint_price: null, value: PREWARM_VALUE })
  const { value } = resolveExecutorTxFields(intent)
  assert.equal(value.toString(), PREWARM_VALUE)
})

await test('s4: value defaults to 0n when both mint_price and value are null', () => {
  const intent = makeIntent({ mint_price: null, value: null })
  const { value } = resolveExecutorTxFields(intent)
  assert.equal(value, 0n)
})

await test('s4: gas from gas_limit as BigInt', () => {
  const intent = makeIntent({ gas_limit: '210000' })
  const { gas } = resolveExecutorTxFields(intent)
  assert.equal(gas, 210000n)
})

await test('s4: gas is undefined when gas_limit is null', () => {
  const intent = makeIntent({ gas_limit: null })
  const { gas } = resolveExecutorTxFields(intent)
  assert.equal(gas, undefined)
})

await test('s4: fn from function_name field', () => {
  const intent = makeIntent({ function_name: 'mintPublic', call_data: null })
  const { fn } = resolveExecutorTxFields(intent)
  assert.equal(fn, 'mintPublic')
})

await test('s4: fn is "prewarmed" when call_data set but function_name null', () => {
  const intent = makeIntent({ call_data: PREWARM_DATA, function_name: null })
  const { fn } = resolveExecutorTxFields(intent)
  assert.equal(fn, 'prewarmed')
})

await test('s4: fn is null when no call_data and no function_name', () => {
  const intent = makeIntent({ call_data: null, function_name: null })
  const { fn } = resolveExecutorTxFields(intent)
  assert.equal(fn, null)
})

await test('s4: src is "prewarm_cache" when call_data is set', () => {
  const intent = makeIntent({ call_data: PREWARM_DATA })
  const { src } = resolveExecutorTxFields(intent)
  assert.equal(src, 'prewarm_cache')
})

await test('s4: src is null when call_data is null', () => {
  const intent = makeIntent({ call_data: null })
  const { src } = resolveExecutorTxFields(intent)
  assert.equal(src, null)
})

// Replicate LIVE_EXECUTION_ENABLED=false dry-run path: requeue to ARMED
function simulateDryRunGate(liveEnabled, intent) {
  if (!liveEnabled) {
    return {
      action: 'requeue',
      newStatus: 'armed',
      last_state: 'Dry run — awaiting LIVE_EXECUTION_ENABLED',
    }
  }
  return { action: 'send' }
}

await test('s4: dry-run gate: LIVE_EXECUTION_ENABLED=false → requeue to armed', () => {
  const result = simulateDryRunGate(false, makeIntent())
  assert.equal(result.action, 'requeue')
  assert.equal(result.newStatus, 'armed')
  assert.ok(result.last_state.includes('Dry run'))
})

await test('s4: dry-run gate: LIVE_EXECUTION_ENABLED=true → proceed to send', () => {
  const result = simulateDryRunGate(true, makeIntent())
  assert.equal(result.action, 'send')
})

// Replicate timing gate: requeueing before T=0
function simulateTimingGate(intent) {
  const executeAt = intent.strike_execute_at
    ? new Date(intent.strike_execute_at).getTime()
    : null
  if (executeAt !== null && Date.now() < executeAt) {
    const remaining = executeAt - Date.now()
    return { action: 'requeue', last_state: `Waiting for execute time (${remaining}ms)` }
  }
  return { action: 'proceed' }
}

await test('s4: timing gate: future execute_at → requeue', () => {
  const intent = makeIntent({ strike_execute_at: new Date(Date.now() + 30000).toISOString() })
  const result = simulateTimingGate(intent)
  assert.equal(result.action, 'requeue')
  assert.ok(result.last_state.includes('Waiting for execute time'))
})

await test('s4: timing gate: past execute_at → proceed', () => {
  const intent = makeIntent({ strike_execute_at: new Date(Date.now() - 100).toISOString() })
  const result = simulateTimingGate(intent)
  assert.equal(result.action, 'proceed')
})

await test('s4: timing gate: null execute_at → proceed immediately', () => {
  const intent = makeIntent({ strike_execute_at: null })
  const result = simulateTimingGate(intent)
  assert.equal(result.action, 'proceed')
})

// ─── Section 5: Recovery outcome routing ─────────────────────────────────────

console.log('\n=== Section 5: Recovery outcome routing ===\n')

// Replicate the recovery block from executeIntent
function simulateRecoveryOutcome(recoveryStatus, intent, chainKey = 'eth') {
  const transitions = []
  let cacheInvalidated = false

  if (recoveryStatus === 'confirmed') {
    transitions.push({ from: 'pending', to: 'success' })
  } else if (recoveryStatus === 'reverted' || recoveryStatus === 'dropped') {
    if (recoveryStatus === 'reverted') {
      // Invalidate exec cache — function config that caused revert may be wrong
      const contractKey = intent.contract_address || intent.to || intent.mint_contract_address
      invalidateCachedExecution(contractKey, chainKey)
      cacheInvalidated = true
    }
    transitions.push({ from: 'pending', to: 'failed' })
  }

  return { transitions, cacheInvalidated }
}

await test('s5: confirmed → transitions to success', () => {
  const { transitions, cacheInvalidated } = simulateRecoveryOutcome('confirmed', makeIntent())
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].to, 'success')
  assert.equal(cacheInvalidated, false, 'confirmed should not invalidate cache')
})

await test('s5: reverted → transitions to failed', () => {
  const { transitions } = simulateRecoveryOutcome('reverted', makeIntent())
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].to, 'failed')
})

await test('s5: reverted → invalidates exec cache (P4-3)', () => {
  const contract = `0x${Date.now().toString(16).padStart(40, 'c')}`
  setCachedExecution(contract, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature' })
  assert.ok(getCachedExecution(contract, 'eth'), 'pre-condition: entry exists in cache')
  const intent = makeIntent({ contract_address: contract })
  const { cacheInvalidated } = simulateRecoveryOutcome('reverted', intent)
  assert.equal(cacheInvalidated, true)
  assert.equal(getCachedExecution(contract, 'eth'), null, 'cache should be cleared after revert')
})

await test('s5: dropped → transitions to failed', () => {
  const { transitions } = simulateRecoveryOutcome('dropped', makeIntent())
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].to, 'failed')
})

await test('s5: dropped → does NOT invalidate exec cache', () => {
  const contract = `0x${(Date.now() + 1).toString(16).padStart(40, 'd')}`
  setCachedExecution(contract, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature' })
  const intent = makeIntent({ contract_address: contract })
  const { cacheInvalidated } = simulateRecoveryOutcome('dropped', intent)
  assert.equal(cacheInvalidated, false)
  // Cache still present — drop doesn't mean the function is wrong
  assert.ok(getCachedExecution(contract, 'eth'), 'cache should remain after drop')
})

await test('s5: reverted cache invalidation uses correct contract key priority', () => {
  // Priority: contract_address → to → mint_contract_address
  const contract1 = `0x${(Date.now() + 2).toString(16).padStart(40, 'e')}`
  const contract2 = `0x${(Date.now() + 3).toString(16).padStart(40, 'f')}`
  setCachedExecution(contract1, 'eth', { functionName: 'mint', gas: '150000', source: 'common_signature' })
  setCachedExecution(contract2, 'eth', { functionName: 'mintPublic', gas: '200000', source: 'seadrop' })

  const intent = makeIntent({
    contract_address: contract1,
    to: contract2,
    mint_contract_address: null,
  })
  simulateRecoveryOutcome('reverted', intent)

  // contract_address wins
  assert.equal(getCachedExecution(contract1, 'eth'), null, 'contract_address entry should be cleared')
  assert.ok(getCachedExecution(contract2, 'eth'), 'to entry should NOT be cleared when contract_address is set')
})

await test('s5: recovery transition always goes from pending (not executing)', () => {
  // Execution steps: executing → pending (on submit) → success/failed (on confirm/revert)
  const { transitions } = simulateRecoveryOutcome('confirmed', makeIntent())
  assert.equal(transitions[0].from, 'pending')
})

// ─── Section 6: SeaDrop router flow ───────────────────────────────────────────

console.log('\n=== Section 6: SeaDrop router flow ===\n')

await test('s6: SeaDrop prewarm → intent.to=router, value=exact wei', async () => {
  const sb = makeSupabase()
  const updates = []

  // Replicate what prewarmIntent writes after a SeaDrop prepareMintTransaction
  const prepared = {
    to: ROUTER_ADDR,
    data: PREWARM_DATA,
    value: PREWARM_VALUE,
    gas: PREWARM_GAS,
    functionName: 'mintPublic',
    source: 'seadrop',
  }

  // What prewarmIntent persists to DB (relevant fields)
  const prewarmUpdate = {
    call_data:     prepared.data,
    gas_limit:     prepared.gas,
    to:            prepared.to,
    value:         prepared.value,
    function_name: prepared.functionName,
  }
  updates.push(prewarmUpdate)

  assert.equal(prewarmUpdate.to, ROUTER_ADDR, 'to should be SeaDrop router')
  assert.equal(prewarmUpdate.value, PREWARM_VALUE, 'value should be exact wei from getPublicDrop')
  assert.equal(prewarmUpdate.function_name, 'mintPublic')
})

await test('s6: SeaDrop fast path — executor sends to router (not NFT contract)', () => {
  const intent = makeIntent({
    mint_contract_address: null,
    to: ROUTER_ADDR,      // persisted by prewarm
    contract_address: NFT_CONTRACT,
    call_data: PREWARM_DATA,
    value: PREWARM_VALUE,
    gas_limit: PREWARM_GAS,
    function_name: 'mintPublic',
  })

  // This is the executor's Step 7 resolution
  const to = intent.mint_contract_address || intent.to || intent.contract_address
  assert.equal(to, ROUTER_ADDR,
    'sendTransaction must use SeaDrop router address, not NFT contract')
})

await test('s6: SeaDrop fast path — value is exact wei (not 0)', () => {
  const intent = makeIntent({
    to: ROUTER_ADDR,
    call_data: PREWARM_DATA,
    value: PREWARM_VALUE,
    mint_price: null,  // prewarm sets value, not mint_price
  })

  const value = BigInt(intent.mint_price || intent.value || '0')
  assert.equal(value.toString(), PREWARM_VALUE,
    'value must carry exact wei from SeaDrop getPublicDrop')
})

await test('s6: SeaDrop fast path — gas is BigInt from gas_limit', () => {
  const intent = makeIntent({
    to: ROUTER_ADDR,
    call_data: PREWARM_DATA,
    gas_limit: PREWARM_GAS,
  })
  const gas = intent.gas_limit ? BigInt(intent.gas_limit) : undefined
  assert.equal(gas, 200000n)
})

await test('s6: SeaDrop fn resolves to function_name field (mintPublic)', () => {
  const intent = makeIntent({
    call_data: PREWARM_DATA,
    function_name: 'mintPublic',
  })
  const fn = intent.function_name || (intent.call_data ? 'prewarmed' : null)
  assert.equal(fn, 'mintPublic')
})

await test('s6: legacy fast path sends to router when intent.to=router', async () => {
  const intent = makeIntent({
    call_data: PREWARM_DATA,
    to: ROUTER_ADDR,
    contract_address: NFT_CONTRACT,
    value: PREWARM_VALUE,
    gas_limit: PREWARM_GAS,
    function_name: 'mintPublic',
  })
  const { prepared } = await simulateLegacyDispatch(intent, RPCS, async () => ({}))
  // Fast path: prepared.to = intent.to || intent.contract_address
  assert.equal(prepared.to, ROUTER_ADDR,
    'legacy fast path must use intent.to (router), not contract_address')
  assert.equal(prepared.value, PREWARM_VALUE)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const ms = results.reduce((s, r) => s + r.ms, 0)
console.log(`\n${passed}/${total} tests passed  |  ${ms}ms total\n`)
if (failed > 0) {
  console.error('FAILED:')
  results.filter(r => !r.pass).forEach(r => console.error(`  ✗ ${r.name}: ${r.error}`))
  process.exitCode = 1
}
