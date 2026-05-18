/**
 * Execution profiler and session telemetry tests.
 * Run: node worker/test/profiler.test.js
 */

import assert from 'assert/strict'
import { createProfiler, recordProfile, getSessionTelemetry } from '../lib/profiler.js'

// ─── createProfiler — basic lifecycle ────────────────────────────────────────

{
  const p = createProfiler('intent-1', 'user-1')
  p.phase('preflight')
  p.phase('simulate')
  const profile = p.finish('success')

  assert.equal(profile.intent_id, 'intent-1')
  assert.equal(profile.user_id, 'user-1')
  assert.equal(profile.outcome, 'success')
  assert.ok(profile.latency_ms >= 0)
  assert.equal(profile.phases.length, 2)
  assert.equal(profile.phases[0].name, 'preflight')
  assert.equal(profile.phases[1].name, 'simulate')
  console.log('✓ profiler lifecycle records phases and outcome')
}

// ─── createProfiler — gas estimation ─────────────────────────────────────────

{
  const p = createProfiler('intent-2', 'user-1')
  p.gasEstimate('aggressive', 25, 50)
  const profile = p.finish('success')

  assert.equal(profile.gas_strategy_final, 'aggressive')
  assert.equal(profile.gas_estimates.length, 1)
  assert.equal(profile.gas_estimates[0].base_fee_gwei, 25)
  assert.equal(profile.gas_estimates[0].max_fee_gwei, 50)
  console.log('✓ profiler records gas estimates')
}

// ─── createProfiler — retry and escalation counters ──────────────────────────

{
  const p = createProfiler('intent-3', 'user-1')
  p.retry('gas_too_low')
  p.retry('network')
  p.gasEscalation()
  const profile = p.finish('success')

  assert.equal(profile.retries, 2)
  assert.equal(profile.gas_escalations, 1)
  console.log('✓ profiler counts retries and escalations')
}

// ─── createProfiler — preflight and pattern recording ────────────────────────

{
  const p = createProfiler('intent-4', 'user-1')
  p.preflight(15, 'low')
  p.pattern('fcfs', 'speed_first')
  const profile = p.finish('success')

  assert.equal(profile.preflight_score, 15)
  assert.equal(profile.preflight_level, 'low')
  assert.equal(profile.mint_pattern, 'fcfs')
  assert.equal(profile.exec_strategy, 'speed_first')
  console.log('✓ profiler records preflight and pattern')
}

// ─── createProfiler — rpc call tracking ──────────────────────────────────────

{
  const p = createProfiler('intent-5', 'user-1')
  p.rpcCall('https://eth.llamarpc.com')
  p.rpcCall('https://rpc.ankr.com/eth')
  const profile = p.finish('simulation_error')

  assert.equal(profile.rpc_calls, 2)
  assert.equal(profile.rpc_provider_used, 'https://rpc.ankr.com/eth')
  console.log('✓ profiler tracks RPC calls, last URL wins')
}

// ─── createProfiler — snapshot captures latency, finish still works ──────────

{
  const p = createProfiler('intent-6', 'user-1')
  p.phase('preflight')
  const snap = p.snapshot()
  // snapshot reports elapsed latency and does not call finish
  assert.ok(snap.latency_ms >= 0)
  assert.equal(snap.outcome, null)
  // finish still works after snapshot
  p.phase('simulate')
  const profile = p.finish('success')
  assert.equal(profile.outcome, 'success')
  assert.equal(profile.phases.length, 2)
  console.log('✓ snapshot captures latency without finalizing; finish still works')
}

// ─── createProfiler — persist no-ops without supabase ────────────────────────

{
  const p = createProfiler('intent-7', 'user-1')
  p.finish('success')
  await p.persist(null) // should not throw
  console.log('✓ persist no-ops without supabase')
}

// ─── createProfiler — persist inserts event ──────────────────────────────────

{
  const events = []
  const mockSupabase = {
    from: () => ({
      insert: (row) => {
        events.push(row)
        return { catch: () => Promise.resolve() }
      },
    }),
  }
  const p = createProfiler('intent-8', 'user-1')
  p.phase('simulate')
  p.finish('success')
  await p.persist(mockSupabase)

  assert.equal(events.length, 1)
  assert.equal(events[0].state, 'execution_profile')
  assert.equal(events[0].intent_id, 'intent-8')
  console.log('✓ persist inserts execution_profile event')
}

// ─── getSessionTelemetry — empty session ─────────────────────────────────────

{
  // Note: session state is module-level. We test after the recordProfile calls below.
  const before = getSessionTelemetry()
  assert.ok(typeof before === 'object')
  assert.ok('session_executions' in before)
  console.log('✓ getSessionTelemetry returns object with session_executions')
}

// ─── recordProfile + getSessionTelemetry — aggregation ───────────────────────

{
  const p1 = createProfiler('agg-1', 'user-1')
  p1.pattern('fcfs', 'speed_first')
  recordProfile(p1.finish('success'))

  const p2 = createProfiler('agg-2', 'user-1')
  p2.pattern('raffle', 'relaxed')
  p2.retry('network')
  recordProfile(p2.finish('simulation_error'))

  const telemetry = getSessionTelemetry()

  assert.ok(telemetry.session_executions >= 2)
  assert.ok(telemetry.outcomes)
  assert.ok(telemetry.patterns)
  assert.ok('fcfs' in telemetry.patterns)
  assert.ok(typeof telemetry.avg_latency_ms === 'number')
  assert.ok(typeof telemetry.success_rate_pct === 'number')
  assert.ok(telemetry.total_retries >= 1)
  console.log('✓ recordProfile + getSessionTelemetry aggregates outcomes and patterns')
}

console.log('\nAll profiler tests passed.')
