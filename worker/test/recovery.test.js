/**
 * Tests for worker/lib/recovery.js and worker/lib/lease.js
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  ORPHAN_TIMEOUT_MS,
  recoverStuckNonce,
  sweepOrphanedExecutions,
  reconcileQueue,
} from '../lib/recovery.js'

import {
  LEASE_TIMEOUT_MS,
  isLeaseExpired,
  parseLeaseMeta,
  checkForConflictingLeases,
} from '../lib/lease.js'

import { nonceTracker } from '../lib/retry.js'

// ─── isLeaseExpired ───────────────────────────────────────────────────────────

describe('isLeaseExpired', () => {
  it('returns true for null lastSeenAt', () => {
    assert.equal(isLeaseExpired(null), true)
  })

  it('returns true for undefined lastSeenAt', () => {
    assert.equal(isLeaseExpired(undefined), true)
  })

  it('returns true when timestamp is older than timeout', () => {
    const old = new Date(Date.now() - LEASE_TIMEOUT_MS - 1000).toISOString()
    assert.equal(isLeaseExpired(old), true)
  })

  it('returns false when timestamp is within timeout', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    assert.equal(isLeaseExpired(recent), false)
  })

  it('respects custom timeoutMs', () => {
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString()
    assert.equal(isLeaseExpired(fiveSecondsAgo, 3000), true)
    assert.equal(isLeaseExpired(fiveSecondsAgo, 10000), false)
  })
})

// ─── parseLeaseMeta ───────────────────────────────────────────────────────────

describe('parseLeaseMeta', () => {
  it('returns null for null row', () => {
    assert.equal(parseLeaseMeta(null), null)
  })

  it('returns null when metadata is missing', () => {
    assert.equal(parseLeaseMeta({}), null)
  })

  it('returns null when worker_id is absent', () => {
    assert.equal(parseLeaseMeta({ metadata: { last_seen_at: new Date().toISOString() } }), null)
  })

  it('returns meta when both fields present', () => {
    const ts  = new Date().toISOString()
    const row = { metadata: { worker_id: 'w-1', last_seen_at: ts, pid: 123 } }
    const out = parseLeaseMeta(row)
    assert.equal(out.worker_id, 'w-1')
    assert.equal(out.last_seen_at, ts)
    assert.equal(out.pid, 123)
  })
})

// ─── recoverStuckNonce ────────────────────────────────────────────────────────

describe('recoverStuckNonce', () => {
  const ADDR = '0xabcd'

  beforeEach(() => {
    nonceTracker.reset?.()
    // Clear manually if reset isn't exposed
    if (typeof nonceTracker.delete === 'function') nonceTracker.delete(ADDR)
  })

  it('seeds from chain when tracker has no entry', async () => {
    const publicClient = {
      getTransactionCount: async () => 5,
    }
    const result = await recoverStuckNonce(publicClient, ADDR)
    assert.equal(result.recovered, true)
    assert.equal(result.chainNonce, 5)
    assert.equal(result.reason, 'seeded_from_chain')
    assert.equal(nonceTracker.get(ADDR), 5)
  })

  it('recovers when chain nonce has advanced past tracker', async () => {
    nonceTracker.set(ADDR, 3)
    const publicClient = {
      getTransactionCount: async () => 7,
    }
    const result = await recoverStuckNonce(publicClient, ADDR)
    assert.equal(result.recovered, true)
    assert.equal(result.chainNonce, 7)
    assert.equal(result.trackedNonce, 3)
    assert.equal(result.reason, 'chain_advanced')
    assert.equal(result.delta, 4)
    assert.equal(nonceTracker.get(ADDR), 7)
  })

  it('resets tracker when tracker is ahead of chain (reorg)', async () => {
    nonceTracker.set(ADDR, 10)
    const publicClient = {
      getTransactionCount: async () => 6,
    }
    const result = await recoverStuckNonce(publicClient, ADDR)
    assert.equal(result.recovered, true)
    assert.equal(result.reason, 'tracker_reset_to_chain')
    assert.equal(nonceTracker.get(ADDR), 6)
  })

  it('returns recovered=false when chain and tracker agree', async () => {
    nonceTracker.set(ADDR, 4)
    const publicClient = {
      getTransactionCount: async () => 4,
    }
    const result = await recoverStuckNonce(publicClient, ADDR)
    assert.equal(result.recovered, false)
    assert.equal(result.chainNonce, 4)
    assert.equal(result.trackedNonce, 4)
  })
})

// ─── sweepOrphanedExecutions ──────────────────────────────────────────────────

describe('sweepOrphanedExecutions', () => {
  function buildSupabase({ orphans = [], updateErr = null } = {}) {
    const insertedEvents = []
    return {
      _insertedEvents: insertedEvents,
      from: (table) => {
        if (table === 'mint_intents') {
          return {
            select: function() { return this },
            in:     function() { return this },
            lt:     function() { return this },
            limit:  function() { return this },
            update: function(patch) {
              return {
                eq:   function() { return this },
                then: (resolve) => Promise.resolve({ error: updateErr }),
                // make it thenable
                [Symbol.toStringTag]: 'Promise',
              }
            },
            // for the select chain
            then: (resolve) => Promise.resolve({ data: orphans, error: null }),
            catch: function() { return this },
          }
        }
        // mint_execution_events
        return {
          insert: async () => null,
        }
      },
    }
  }

  it('returns 0 when no orphaned intents are found', async () => {
    const supabase = {
      from: () => ({
        select: function() { return this },
        in:     function() { return this },
        lt:     function() { return this },
        limit:  () => Promise.resolve({ data: [], error: null }),
        update: function() { return { eq: function() { return this } } },
      }),
    }
    const count = await sweepOrphanedExecutions(supabase)
    assert.equal(count, 0)
  })

  it('returns 0 on DB query error', async () => {
    const supabase = {
      from: () => ({
        select: function() { return this },
        in:     function() { return this },
        lt:     function() { return this },
        limit:  () => Promise.resolve({ data: null, error: { message: 'DB down' } }),
      }),
    }
    const count = await sweepOrphanedExecutions(supabase)
    assert.equal(count, 0)
  })

  it('recovers an orphaned executing intent', async () => {
    const orphanedSince = new Date(Date.now() - ORPHAN_TIMEOUT_MS - 5000).toISOString()
    const orphan = {
      id:         'intent-orphan',
      user_id:    'user-1',
      status:     'executing',
      updated_at: orphanedSince,
    }

    // Track calls to differentiate select vs. update
    let intentCallCount = 0

    const supabase = {
      from: (table) => {
        if (table === 'mint_intents') {
          intentCallCount++
          const call = intentCallCount

          if (call === 1) {
            // First call: select query for orphans
            return {
              select: function() { return this },
              in:     function() { return this },
              lt:     function() { return this },
              limit:  () => Promise.resolve({ data: [orphan], error: null }),
            }
          }
          // Subsequent calls: update (optimistic reset)
          return {
            update: () => ({
              eq: function() { return this },
              then: (onFulfilled, onRejected) =>
                Promise.resolve({ error: null }).then(onFulfilled, onRejected),
              catch: (fn) => Promise.resolve({ error: null }).catch(fn),
            }),
          }
        }
        // mint_execution_events
        return {
          insert: (row) => Promise.resolve({ error: null }),
        }
      },
    }

    const count = await sweepOrphanedExecutions(supabase)
    assert.equal(count, 1)
  })
})

// ─── reconcileQueue ───────────────────────────────────────────────────────────

describe('reconcileQueue', () => {
  it('returns orphansRecovered and queueHealth', async () => {
    let callCount = 0

    const supabase = {
      from: (table) => {
        if (table === 'mint_intents') {
          callCount++
          if (callCount === 1) {
            // Orphan sweep: no orphans found
            return {
              select: function() { return this },
              in:     function() { return this },
              lt:     function() { return this },
              limit:  () => Promise.resolve({ data: [], error: null }),
            }
          }
          // Queue health snapshot: return some status rows
          return {
            select: function() { return this },
            eq:     function() { return this },
            in:     () => Promise.resolve({ data: [{ status: 'armed' }, { status: 'armed' }] }),
          }
        }
        return { insert: async () => null }
      },
    }

    const result = await reconcileQueue(supabase)
    assert.ok('orphansRecovered' in result)
    assert.ok('queueHealth' in result)
    assert.equal(typeof result.orphansRecovered, 'number')
    assert.ok(result.queueHealth !== null)
  })
})

// ─── checkForConflictingLeases ────────────────────────────────────────────────

describe('checkForConflictingLeases', () => {
  const OWN_WORKER = 'worker-1234-abc'

  it('returns null when no lease rows exist', async () => {
    const supabase = {
      from: () => ({
        select: function() { return this },
        eq:     function() { return this },
        is:     function() { return this },
        order:  function() { return this },
        limit:  () => Promise.resolve({ data: [] }),
      }),
    }
    const result = await checkForConflictingLeases(supabase, OWN_WORKER)
    assert.equal(result, null)
  })

  it('returns null when only our own lease is present', async () => {
    const recentTs = new Date().toISOString()
    const row = {
      metadata: { worker_id: OWN_WORKER, last_seen_at: recentTs, pid: 1 },
    }
    const supabase = {
      from: () => ({
        select: function() { return this },
        eq:     function() { return this },
        is:     function() { return this },
        order:  function() { return this },
        limit:  () => Promise.resolve({ data: [row] }),
      }),
    }
    const result = await checkForConflictingLeases(supabase, OWN_WORKER)
    assert.equal(result, null)
  })

  it('returns conflict when another worker holds an active lease', async () => {
    const recentTs = new Date().toISOString()
    const row = {
      metadata: { worker_id: 'worker-other-xyz', last_seen_at: recentTs, pid: 999 },
    }
    const supabase = {
      from: () => ({
        select: function() { return this },
        eq:     function() { return this },
        is:     function() { return this },
        order:  function() { return this },
        limit:  () => Promise.resolve({ data: [row] }),
      }),
    }
    const result = await checkForConflictingLeases(supabase, OWN_WORKER)
    assert.ok(result !== null)
    assert.equal(result.worker_id, 'worker-other-xyz')
  })

  it('returns null when other worker lease is expired', async () => {
    const expiredTs = new Date(Date.now() - LEASE_TIMEOUT_MS - 5000).toISOString()
    const row = {
      metadata: { worker_id: 'worker-old', last_seen_at: expiredTs, pid: 888 },
    }
    const supabase = {
      from: () => ({
        select: function() { return this },
        eq:     function() { return this },
        is:     function() { return this },
        order:  function() { return this },
        limit:  () => Promise.resolve({ data: [row] }),
      }),
    }
    const result = await checkForConflictingLeases(supabase, OWN_WORKER)
    assert.equal(result, null)
  })

  it('returns null on DB error (advisory)', async () => {
    const supabase = {
      from: () => ({
        select: function() { return this },
        eq:     function() { return this },
        is:     function() { return this },
        order:  function() { return this },
        limit:  () => Promise.reject(new Error('DB unavailable')),
      }),
    }
    const result = await checkForConflictingLeases(supabase, OWN_WORKER)
    assert.equal(result, null)
  })
})
