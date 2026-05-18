/**
 * Tests for worker/lib/monitor.js
 * Run: node worker/test/monitor.test.js
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALERT_TYPES,
  SEVERITY,
  detectProjectChanges,
  detectStealthDelay,
  shouldCheckThisTick,
  buildDedupKey,
  buildAlertTitle,
  buildAlertMessage,
} from '../lib/monitor.js'

// ─── detectProjectChanges ─────────────────────────────────────────────────────

describe('detectProjectChanges', () => {
  const base = {
    status:           'upcoming',
    mint_date:        '2026-06-01T18:00:00Z',
    mint_price:       '0.05',
    supply:           '5000',
    contract_address: null,
  }

  it('returns empty array on first observation (no stored state)', () => {
    const changes = detectProjectChanges(null, base)
    assert.equal(changes.length, 0)
  })

  it('returns empty array when nothing changed', () => {
    const stored = {
      last_status:   'upcoming',
      last_mint_date: '2026-06-01T18:00:00Z',
      last_price:    '0.05',
      last_supply:   '5000',
      last_contract: null,
    }
    const changes = detectProjectChanges(stored, base)
    assert.equal(changes.length, 0)
  })

  it('detects project going live as CRITICAL', () => {
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: null, last_supply: null, last_contract: null }
    const fresh  = { ...base, status: 'live' }
    const changes = detectProjectChanges(stored, fresh)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].type, ALERT_TYPES.PROJECT_LIVE)
    assert.equal(changes[0].severity, SEVERITY.CRITICAL)
  })

  it('detects cancellation as WARNING', () => {
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: null, last_supply: null, last_contract: null }
    const fresh  = { ...base, status: 'cancelled' }
    const changes = detectProjectChanges(stored, fresh)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].type, ALERT_TYPES.PROJECT_CANCELLED)
    assert.equal(changes[0].severity, SEVERITY.WARNING)
  })

  it('detects schedule change', () => {
    const stored = {
      last_status:    'upcoming',
      last_mint_date: '2026-06-01T18:00:00Z',
      last_price:     '0.05',
      last_supply:    null,
      last_contract:  null,
    }
    const fresh = { ...base, mint_date: '2026-06-03T20:00:00Z' }
    const changes = detectProjectChanges(stored, fresh)
    const sched = changes.find(c => c.type === ALERT_TYPES.SCHEDULE_CHANGED)
    assert.ok(sched, 'expected schedule_changed alert')
    assert.equal(sched.severity, SEVERITY.WARNING)
  })

  it('detects price change', () => {
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: '0.05', last_supply: null, last_contract: null }
    const fresh  = { ...base, mint_price: '0.08' }
    const changes = detectProjectChanges(stored, fresh)
    const price = changes.find(c => c.type === ALERT_TYPES.PRICE_CHANGED)
    assert.ok(price, 'expected price_changed alert')
    assert.equal(price.from, '0.05')
    assert.equal(price.to, '0.08')
  })

  it('detects supply change', () => {
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: null, last_supply: '5000', last_contract: null }
    const fresh  = { ...base, supply: '3000' }
    const changes = detectProjectChanges(stored, fresh)
    const supply = changes.find(c => c.type === ALERT_TYPES.SUPPLY_CHANGED)
    assert.ok(supply, 'expected supply_changed alert')
  })

  it('detects contract newly appearing', () => {
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: null, last_supply: null, last_contract: null }
    const fresh  = { ...base, contract_address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' }
    const changes = detectProjectChanges(stored, fresh)
    const deployed = changes.find(c => c.type === ALERT_TYPES.CONTRACT_DEPLOYED)
    assert.ok(deployed, 'expected contract_deployed alert')
    assert.equal(deployed.severity, SEVERITY.INFO)
  })

  it('does not alert when contract was already present', () => {
    const addr   = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: null, last_supply: null, last_contract: addr }
    const fresh  = { ...base, contract_address: addr }
    const changes = detectProjectChanges(stored, fresh)
    assert.equal(changes.filter(c => c.type === ALERT_TYPES.CONTRACT_DEPLOYED).length, 0)
  })

  it('ignores price change when value looks like a contract address', () => {
    const addr   = '0xabcdef0123456789abcdef0123456789abcdef01'
    const stored = { last_status: 'upcoming', last_mint_date: null, last_price: addr, last_supply: null, last_contract: null }
    const fresh  = { ...base, mint_price: '0.05' }
    // addr normalises to null so no stored price to compare
    const changes = detectProjectChanges(stored, fresh)
    assert.equal(changes.filter(c => c.type === ALERT_TYPES.PRICE_CHANGED).length, 0)
  })

  it('detects multiple changes simultaneously', () => {
    const stored = {
      last_status:    'upcoming',
      last_mint_date: '2026-06-01T18:00:00Z',
      last_price:     '0.05',
      last_supply:    '5000',
      last_contract:  null,
    }
    const fresh = {
      status:           'live',
      mint_date:        '2026-06-01T18:00:00Z',
      mint_price:       '0.08',
      supply:           '3000',
      contract_address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    }
    const changes = detectProjectChanges(stored, fresh)
    // live, price_changed, supply_changed, contract_deployed
    assert.ok(changes.length >= 3)
  })
})

// ─── detectStealthDelay ───────────────────────────────────────────────────────

describe('detectStealthDelay', () => {
  it('returns false for live projects', () => {
    const project = { status: 'live', mint_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }
    assert.equal(detectStealthDelay(project), false)
  })

  it('returns false for upcoming projects not yet past mint time', () => {
    const project = { status: 'upcoming', mint_date: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
    assert.equal(detectStealthDelay(project), false)
  })

  it('returns false for upcoming within the 30-min grace window', () => {
    const project = { status: 'upcoming', mint_date: new Date(Date.now() - 10 * 60 * 1000).toISOString() }
    assert.equal(detectStealthDelay(project), false)
  })

  it('returns true for upcoming past mint_date by more than 30 min', () => {
    const project = { status: 'upcoming', mint_date: new Date(Date.now() - 35 * 60 * 1000).toISOString() }
    assert.equal(detectStealthDelay(project), true)
  })

  it('returns false for minted/missed/cancelled projects', () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    assert.equal(detectStealthDelay({ status: 'minted',    mint_date: past }), false)
    assert.equal(detectStealthDelay({ status: 'missed',    mint_date: past }), false)
    assert.equal(detectStealthDelay({ status: 'cancelled', mint_date: past }), false)
  })

  it('returns false when mint_date is missing', () => {
    assert.equal(detectStealthDelay({ status: 'upcoming', mint_date: null }), false)
  })
})

// ─── shouldCheckThisTick ─────────────────────────────────────────────────────

describe('shouldCheckThisTick', () => {
  const TICK = 5 * 60 * 1000
  const now  = Date.now()

  it('always checks when never checked before', () => {
    const project = { status: 'upcoming', mint_date: new Date(now + 48 * 60 * 60 * 1000).toISOString() }
    assert.equal(shouldCheckThisTick(project, null, TICK, now), true)
  })

  it('skips terminal states', () => {
    const past = new Date(now - 60 * 60 * 1000).toISOString()
    assert.equal(shouldCheckThisTick({ status: 'minted',    mint_date: past }, past, TICK, now), false)
    assert.equal(shouldCheckThisTick({ status: 'missed',    mint_date: past }, past, TICK, now), false)
    assert.equal(shouldCheckThisTick({ status: 'cancelled', mint_date: past }, past, TICK, now), false)
  })

  it('always checks within 1 hour of mint', () => {
    const mintDate    = new Date(now + 30 * 60 * 1000).toISOString()
    const lastChecked = new Date(now - 30 * 1000).toISOString()  // 30s ago
    const project     = { status: 'upcoming', mint_date: mintDate }
    assert.equal(shouldCheckThisTick(project, lastChecked, TICK, now), true)
  })

  it('skips 1-24hr projects if checked within 3 ticks', () => {
    const mintDate    = new Date(now + 6 * 60 * 60 * 1000).toISOString()
    const lastChecked = new Date(now - TICK).toISOString()  // only 1 tick ago
    const project     = { status: 'upcoming', mint_date: mintDate }
    assert.equal(shouldCheckThisTick(project, lastChecked, TICK, now), false)
  })

  it('checks 1-24hr projects after 3 ticks', () => {
    const mintDate    = new Date(now + 6 * 60 * 60 * 1000).toISOString()
    const lastChecked = new Date(now - TICK * 4).toISOString()  // 4 ticks ago
    const project     = { status: 'upcoming', mint_date: mintDate }
    assert.equal(shouldCheckThisTick(project, lastChecked, TICK, now), true)
  })

  it('skips >24hr projects if checked within 12 ticks', () => {
    const mintDate    = new Date(now + 48 * 60 * 60 * 1000).toISOString()
    const lastChecked = new Date(now - TICK * 6).toISOString()
    const project     = { status: 'upcoming', mint_date: mintDate }
    assert.equal(shouldCheckThisTick(project, lastChecked, TICK, now), false)
  })

  it('checks >24hr projects after 12 ticks', () => {
    const mintDate    = new Date(now + 48 * 60 * 60 * 1000).toISOString()
    const lastChecked = new Date(now - TICK * 13).toISOString()
    const project     = { status: 'upcoming', mint_date: mintDate }
    assert.equal(shouldCheckThisTick(project, lastChecked, TICK, now), true)
  })
})

// ─── buildDedupKey ───────────────────────────────────────────────────────────

describe('buildDedupKey', () => {
  it('combines type and entityId', () => {
    assert.equal(buildDedupKey('project_live', 'proj-1'), 'project_live:proj-1')
  })
})

// ─── buildAlertTitle / buildAlertMessage ─────────────────────────────────────

describe('buildAlertTitle', () => {
  it('returns live title for project_live', () => {
    const t = buildAlertTitle(ALERT_TYPES.PROJECT_LIVE, 'CoolProject')
    assert.ok(t.includes('CoolProject'))
    assert.ok(t.toLowerCase().includes('live'))
  })

  it('returns delay title for stealth_delay', () => {
    const t = buildAlertTitle(ALERT_TYPES.STEALTH_DELAY, 'SlowMint')
    assert.ok(t.includes('SlowMint'))
  })

  it('handles unknown type gracefully', () => {
    const t = buildAlertTitle('unknown_type', 'X')
    assert.ok(typeof t === 'string')
  })
})

describe('buildAlertMessage', () => {
  const project = { name: 'Test', chain: 'base', contract_address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' }

  it('mentions chain for project_live', () => {
    const msg = buildAlertMessage(ALERT_TYPES.PROJECT_LIVE, {}, project)
    assert.ok(msg.toLowerCase().includes('base'))
  })

  it('formats price change with from/to', () => {
    const msg = buildAlertMessage(ALERT_TYPES.PRICE_CHANGED, { from: '0.05', to: '0.08' }, project)
    assert.ok(msg.includes('0.05'))
    assert.ok(msg.includes('0.08'))
  })

  it('formats schedule change with dates', () => {
    const from = '2026-06-01T18:00:00Z'
    const to   = '2026-06-03T20:00:00Z'
    const msg  = buildAlertMessage(ALERT_TYPES.SCHEDULE_CHANGED, { from, to }, project)
    assert.ok(msg.length > 10)
  })
})
