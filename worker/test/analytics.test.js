/**
 * Replay analytics tests.
 * Run: node worker/test/analytics.test.js
 */

import assert from 'assert/strict'
import { summarizeReplay, aggregateReplayAnalytics } from '../lib/analytics.js'

function makeEvent(state, message = '', metadata = {}, created_at = new Date().toISOString()) {
  return { state, message, metadata, created_at }
}

// ─── summarizeReplay — empty events ──────────────────────────────────────────

{
  const s = summarizeReplay([])
  assert.equal(s.total_events, 0)
  assert.equal(s.outcome, null)
  assert.equal(s.retries, 0)
  assert.equal(s.latency_ms, null)
  console.log('✓ summarizeReplay empty events returns null outcome')
}

{
  const s = summarizeReplay(null)
  assert.equal(s.total_events, 0)
  console.log('✓ summarizeReplay null input returns zero summary')
}

// ─── summarizeReplay — successful run ────────────────────────────────────────

{
  const events = [
    makeEvent('sim_start', 'Started', {}, '2026-01-01T00:00:00Z'),
    makeEvent('gas_estimate', 'Gas estimated', { elapsed_ms: 50 }, '2026-01-01T00:00:01Z'),
    makeEvent('simulated_success', 'Done', { elapsed_ms: 120 }, '2026-01-01T00:00:02Z'),
  ]
  const s = summarizeReplay(events)

  assert.equal(s.total_events, 3)
  assert.equal(s.outcome, 'success')
  assert.equal(s.latency_ms, 120)
  assert.equal(s.retries, 0)
  assert.equal(s.first_event_at, '2026-01-01T00:00:00Z')
  assert.equal(s.last_event_at, '2026-01-01T00:00:02Z')
  console.log('✓ summarizeReplay identifies successful outcome')
}

// ─── summarizeReplay — failed run ────────────────────────────────────────────

{
  const events = [
    makeEvent('sim_start', 'Started', {}),
    makeEvent('retry', 'Retry 1', {}),
    makeEvent('retry', 'Retry 2', {}),
    makeEvent('simulated_failure', 'Failed: revert', { elapsed_ms: 300 }),
  ]
  const s = summarizeReplay(events)

  assert.equal(s.outcome, 'failed')
  assert.equal(s.retries, 2)
  assert.equal(s.latency_ms, 300)
  assert.ok(s.error?.includes('Failed: revert'))
  console.log('✓ summarizeReplay identifies failed outcome with retries')
}

// ─── summarizeReplay — gas escalations and RPC failovers ─────────────────────

{
  const events = [
    makeEvent('sim_start'),
    makeEvent('gas_escalation'),
    makeEvent('gas_escalation'),
    makeEvent('rpc_failover'),
    makeEvent('simulated_success'),
  ]
  const s = summarizeReplay(events)

  assert.equal(s.gas_escalations, 2)
  assert.equal(s.rpc_failovers, 1)
  console.log('✓ summarizeReplay counts gas escalations and RPC failovers')
}

// ─── summarizeReplay — unique phases ─────────────────────────────────────────

{
  const events = [
    makeEvent('sim_start'),
    makeEvent('sim_start'), // duplicate
    makeEvent('gas_estimate'),
    makeEvent('simulated_success'),
  ]
  const s = summarizeReplay(events)

  assert.equal(s.phases.length, 3) // sim_start, gas_estimate, simulated_success
  assert.ok(s.phases.includes('sim_start'))
  assert.ok(s.phases.includes('gas_estimate'))
  console.log('✓ summarizeReplay deduplicates phases')
}

// ─── aggregateReplayAnalytics — empty ────────────────────────────────────────

{
  const r = aggregateReplayAnalytics([])
  assert.equal(r.count, 0)
  console.log('✓ aggregateReplayAnalytics empty input returns count 0')
}

{
  const r = aggregateReplayAnalytics(null)
  assert.equal(r.count, 0)
  console.log('✓ aggregateReplayAnalytics null input returns count 0')
}

// ─── aggregateReplayAnalytics — basic aggregation ────────────────────────────

{
  const summaries = [
    { outcome: 'success', latency_ms: 100, retries: 0, gas_escalations: 0, rpc_failovers: 0 },
    { outcome: 'success', latency_ms: 200, retries: 1, gas_escalations: 1, rpc_failovers: 0 },
    { outcome: 'failed',  latency_ms: 300, retries: 3, gas_escalations: 2, rpc_failovers: 1 },
  ]
  const r = aggregateReplayAnalytics(summaries)

  assert.equal(r.count, 3)
  assert.equal(r.outcome_breakdown.success, 2)
  assert.equal(r.outcome_breakdown.failed, 1)
  assert.equal(r.success_rate_pct, 67) // Math.round(2/3 * 100)
  assert.equal(r.avg_latency_ms, 200)
  assert.equal(r.total_retries, 4)
  assert.equal(r.total_gas_escalations, 3)
  assert.equal(r.total_rpc_failovers, 1)
  assert.equal(r.avg_retries_per_execution, Number((4 / 3).toFixed(2)))
  console.log('✓ aggregateReplayAnalytics computes full report')
}

// ─── aggregateReplayAnalytics — null latencies excluded from avg ──────────────

{
  const summaries = [
    { outcome: 'success', latency_ms: 100, retries: 0, gas_escalations: 0, rpc_failovers: 0 },
    { outcome: 'failed',  latency_ms: null, retries: 0, gas_escalations: 0, rpc_failovers: 0 },
  ]
  const r = aggregateReplayAnalytics(summaries)

  assert.equal(r.avg_latency_ms, 100) // only non-null counted
  console.log('✓ aggregateReplayAnalytics excludes null latencies from average')
}

// ─── aggregateReplayAnalytics — all failures ─────────────────────────────────

{
  const summaries = [
    { outcome: 'failed', latency_ms: 50, retries: 2, gas_escalations: 0, rpc_failovers: 0 },
    { outcome: 'failed', latency_ms: 75, retries: 3, gas_escalations: 0, rpc_failovers: 0 },
  ]
  const r = aggregateReplayAnalytics(summaries)

  assert.equal(r.success_rate_pct, 0)
  assert.ok(!('success' in r.outcome_breakdown))
  console.log('✓ aggregateReplayAnalytics handles all-failure session')
}

console.log('\nAll analytics tests passed.')
