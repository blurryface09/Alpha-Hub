/**
 * Tests for worker/lib/alerter.js
 * Run: node worker/test/alerter.test.js
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAlert, getAlertHistory, getDedupWindowMs } from '../lib/alerter.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSupabase({ existingAlerts = [], insertId = 'new-alert-id', insertError = null } = {}) {
  const inserted = []

  const makeChain = (result) => {
    const obj = {
      eq:         function() { return this },
      filter:     function() { return this },
      gte:        function() { return this },
      limit:      function() { return this },
      order:      function() { return this },
      range:      function() { return this },
      maybeSingle: async () => result,
      select:     function() { return this },
      update:     function() { return this },
      then:       (onFulfilled) => Promise.resolve(result).then(onFulfilled),
      [Symbol.toStringTag]: 'Promise',
    }
    return obj
  }

  return {
    _inserted: inserted,
    from: (table) => {
      if (table === 'notifications') {
        return {
          select: function() {
            // Dedup check query
            return {
              eq:          function() { return this },
              filter:      function() { return this },
              gte:         function() { return this },
              limit:       () => Promise.resolve({ data: existingAlerts }),
              order:       function() { return this },
              range:       function(from, to) {
                return Promise.resolve({
                  data: existingAlerts.slice(from, to + 1),
                  error: null,
                })
              },
            }
          },
          insert: (row) => {
            inserted.push(row)
            return {
              select: function() { return this },
              maybeSingle: async () => ({
                data:  insertError ? null : { id: insertId },
                error: insertError,
              }),
            }
          },
          update: function() { return makeChain({ error: null }) },
        }
      }
      return {}
    },
  }
}

// ─── createAlert ─────────────────────────────────────────────────────────────

describe('createAlert', () => {
  it('inserts alert and returns id when no dedup conflict', async () => {
    const supabase = buildSupabase({ existingAlerts: [] })
    const id = await createAlert(supabase, {
      userId:   'user-1',
      type:     'project_live',
      title:    'Test is LIVE',
      message:  'Mint is live on ETH.',
      severity: 'critical',
      dedupKey: 'project_live:test-project',
    })
    assert.equal(id, 'new-alert-id')
    assert.equal(supabase._inserted.length, 1)
    assert.equal(supabase._inserted[0].type, 'project_live')
    assert.equal(supabase._inserted[0].data.severity, 'critical')
    assert.equal(supabase._inserted[0].data.dedup_key, 'project_live:test-project')
  })

  it('returns null (deduped) when same alert exists within window', async () => {
    const existing = [{
      id:         'existing-alert',
      type:       'project_live',
      created_at: new Date().toISOString(),
    }]
    const supabase = buildSupabase({ existingAlerts: existing })
    const id = await createAlert(supabase, {
      userId:   'user-1',
      type:     'project_live',
      title:    'Test is LIVE',
      message:  'Mint is live.',
      dedupKey: 'project_live:test-project',
    })
    assert.equal(id, null)
    assert.equal(supabase._inserted.length, 0)
  })

  it('fires without dedup when dedupKey is null', async () => {
    const supabase = buildSupabase({ existingAlerts: [] })
    const id = await createAlert(supabase, {
      userId:  'user-1',
      type:    'system',
      title:   'System alert',
      message: 'Test.',
      dedupKey: null,
    })
    assert.equal(id, 'new-alert-id')
  })

  it('returns null when userId is missing', async () => {
    const supabase = buildSupabase()
    const id = await createAlert(supabase, { userId: null, type: 'project_live', title: 'X', message: 'Y' })
    assert.equal(id, null)
  })

  it('returns null when title is missing', async () => {
    const supabase = buildSupabase()
    const id = await createAlert(supabase, { userId: 'u', type: 'project_live', title: '', message: 'Y' })
    assert.equal(id, null)
  })

  it('stores severity in data jsonb', async () => {
    const supabase = buildSupabase({ existingAlerts: [] })
    await createAlert(supabase, {
      userId:   'user-1',
      type:     'stealth_delay',
      title:    'Delayed',
      message:  'Was supposed to mint.',
      severity: 'warning',
    })
    assert.equal(supabase._inserted[0].data.severity, 'warning')
  })

  it('merges extra data fields', async () => {
    const supabase = buildSupabase({ existingAlerts: [] })
    await createAlert(supabase, {
      userId:  'user-1',
      type:    'price_changed',
      title:   'Price changed',
      message: 'From 0.05 to 0.08',
      data:    { project_id: 'proj-1', change_from: '0.05', change_to: '0.08' },
    })
    const row = supabase._inserted[0]
    assert.equal(row.data.project_id, 'proj-1')
    assert.equal(row.data.change_from, '0.05')
  })

  it('handles DB insert error gracefully (returns null)', async () => {
    const supabase = buildSupabase({
      existingAlerts: [],
      insertError: { message: 'DB error' },
    })
    const id = await createAlert(supabase, {
      userId:  'user-1',
      type:    'project_live',
      title:   'Live',
      message: 'Live now.',
    })
    assert.equal(id, null)
  })
})

// ─── getDedupWindowMs ────────────────────────────────────────────────────────

describe('getDedupWindowMs', () => {
  it('returns 30 min for project_live', () => {
    assert.equal(getDedupWindowMs('project_live'), 30 * 60 * 1000)
  })

  it('returns 1 hour for schedule_changed', () => {
    assert.equal(getDedupWindowMs('schedule_changed'), 60 * 60 * 1000)
  })

  it('returns default 1 hour for unknown types', () => {
    assert.equal(getDedupWindowMs('unknown_type'), 60 * 60 * 1000)
  })

  it('returns 24 hours for contract_deployed', () => {
    assert.equal(getDedupWindowMs('contract_deployed'), 24 * 60 * 60 * 1000)
  })
})

// ─── getAlertHistory ─────────────────────────────────────────────────────────

describe('getAlertHistory', () => {
  it('returns alerts for user', async () => {
    const alerts = [
      { id: '1', type: 'project_live', created_at: new Date().toISOString() },
      { id: '2', type: 'whale_mint',   created_at: new Date().toISOString() },
    ]
    const supabase = buildSupabase({ existingAlerts: alerts })
    const result = await getAlertHistory(supabase, 'user-1')
    assert.ok(Array.isArray(result))
  })
})
