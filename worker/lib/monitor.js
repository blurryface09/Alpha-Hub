/**
 * Monitoring intelligence engine.
 * Pure functions for change detection, severity classification,
 * stealth delay detection, and polling backoff decisions.
 * No DB dependencies — all logic is independently testable.
 */

// ─── Alert types ──────────────────────────────────────────────────────────────

export const ALERT_TYPES = {
  PROJECT_LIVE:       'project_live',
  STEALTH_DELAY:      'stealth_delay',
  SCHEDULE_CHANGED:   'schedule_changed',
  PRICE_CHANGED:      'price_changed',
  SUPPLY_CHANGED:     'supply_changed',
  CONTRACT_DEPLOYED:  'contract_deployed',
  PROJECT_CANCELLED:  'project_cancelled',
  STATUS_CHANGED:     'status_changed',
}

// ─── Severity levels ──────────────────────────────────────────────────────────

export const SEVERITY = {
  CRITICAL: 'critical',
  WARNING:  'warning',
  INFO:     'info',
}

// ─── Change detection ─────────────────────────────────────────────────────────

/**
 * Compare stored monitor state with fresh project data.
 * Returns an array of detected changes.
 *
 * @param {object|null} stored  — monitor_state row (null = first time)
 * @param {object}      fresh   — calendar_projects row
 * @returns {{ type, severity, field, from, to }[]}
 */
export function detectProjectChanges(stored, fresh) {
  const changes = []

  // First observation — seed the state, no alerts
  if (!stored) return changes

  // Status change
  if (stored.last_status && stored.last_status !== fresh.status) {
    if (fresh.status === 'live') {
      changes.push({
        type:     ALERT_TYPES.PROJECT_LIVE,
        severity: SEVERITY.CRITICAL,
        field:    'status',
        from:     stored.last_status,
        to:       fresh.status,
      })
    } else if (fresh.status === 'cancelled') {
      changes.push({
        type:     ALERT_TYPES.PROJECT_CANCELLED,
        severity: SEVERITY.WARNING,
        field:    'status',
        from:     stored.last_status,
        to:       fresh.status,
      })
    } else {
      changes.push({
        type:     ALERT_TYPES.STATUS_CHANGED,
        severity: SEVERITY.INFO,
        field:    'status',
        from:     stored.last_status,
        to:       fresh.status,
      })
    }
  }

  // Schedule change (non-null → different non-null)
  const storedDate = stored.last_mint_date ? new Date(stored.last_mint_date).toISOString() : null
  const freshDate  = fresh.mint_date       ? new Date(fresh.mint_date).toISOString()       : null
  if (storedDate && freshDate && storedDate !== freshDate) {
    changes.push({
      type:     ALERT_TYPES.SCHEDULE_CHANGED,
      severity: SEVERITY.WARNING,
      field:    'mint_date',
      from:     stored.last_mint_date,
      to:       fresh.mint_date,
    })
  }

  // Price change
  const storedPrice = normalizePrice(stored.last_price)
  const freshPrice  = normalizePrice(fresh.mint_price)
  if (storedPrice && freshPrice && storedPrice !== freshPrice) {
    changes.push({
      type:     ALERT_TYPES.PRICE_CHANGED,
      severity: SEVERITY.WARNING,
      field:    'mint_price',
      from:     stored.last_price,
      to:       fresh.mint_price,
    })
  }

  // Supply change
  const storedSupply = String(stored.last_supply || '').trim()
  const freshSupply  = String(fresh.supply        || '').trim()
  if (storedSupply && freshSupply && storedSupply !== freshSupply) {
    changes.push({
      type:     ALERT_TYPES.SUPPLY_CHANGED,
      severity: SEVERITY.INFO,
      field:    'supply',
      from:     stored.last_supply,
      to:       fresh.supply,
    })
  }

  // Contract address newly appeared
  if (!stored.last_contract && fresh.contract_address) {
    changes.push({
      type:     ALERT_TYPES.CONTRACT_DEPLOYED,
      severity: SEVERITY.INFO,
      field:    'contract_address',
      from:     null,
      to:       fresh.contract_address,
    })
  }

  return changes
}

// ─── Stealth delay detection ──────────────────────────────────────────────────

/**
 * Detect if a project is past its scheduled mint time but hasn't gone live.
 * Returns true if the project is more than 30 min past mint_date and still upcoming.
 *
 * @param {object} project
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function detectStealthDelay(project, nowMs = Date.now()) {
  if (!['upcoming', 'live'].includes(project.status)) return false
  if (!project.mint_date) return false
  const mintAt = new Date(project.mint_date).getTime()
  if (isNaN(mintAt)) return false
  // Past mint_date by more than 30 min but not showing as live
  return project.status === 'upcoming' && nowMs > mintAt + 30 * 60 * 1000
}

// ─── Polling backoff ──────────────────────────────────────────────────────────

/**
 * Returns true if this project should be checked in the current tick.
 * Implements adaptive backoff: check more frequently close to mint time.
 *
 * @param {object} project
 * @param {string|null} lastCheckedAt  — ISO timestamp of last check
 * @param {number} [tickMs]            — cron interval in ms (default 5min)
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function shouldCheckThisTick(project, lastCheckedAt, tickMs = 5 * 60 * 1000, nowMs = Date.now()) {
  // Terminal states — no point rechecking
  if (['missed', 'cancelled', 'minted'].includes(project.status)) return false

  // Never checked yet
  if (!lastCheckedAt) return true

  const lastMs    = new Date(lastCheckedAt).getTime()
  const staleness = nowMs - lastMs

  if (!project.mint_date) return staleness >= tickMs * 3  // 15min for TBD

  const mintAt     = new Date(project.mint_date).getTime()
  const msUntilMint = mintAt - nowMs

  // Within 1 hour either side of mint — check every tick
  if (msUntilMint > -60 * 60 * 1000 && msUntilMint < 60 * 60 * 1000) return true

  // 1–24 hours away — every 3 ticks (15 min)
  if (msUntilMint > 0 && msUntilMint < 24 * 60 * 60 * 1000) return staleness >= tickMs * 3

  // More than 24 hours away — every 12 ticks (~1 hr)
  return staleness >= tickMs * 12
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Build a stable dedup key for an alert (type + entity).
 * @param {string} type
 * @param {string} entityId
 * @returns {string}
 */
export function buildDedupKey(type, entityId) {
  return `${type}:${entityId}`
}

// ─── Alert copy helpers ───────────────────────────────────────────────────────

export function buildAlertTitle(type, projectName) {
  switch (type) {
    case ALERT_TYPES.PROJECT_LIVE:      return `${projectName} is LIVE`
    case ALERT_TYPES.STEALTH_DELAY:     return `${projectName} may be delayed`
    case ALERT_TYPES.SCHEDULE_CHANGED:  return `${projectName} schedule changed`
    case ALERT_TYPES.PRICE_CHANGED:     return `${projectName} price changed`
    case ALERT_TYPES.SUPPLY_CHANGED:    return `${projectName} supply updated`
    case ALERT_TYPES.CONTRACT_DEPLOYED: return `${projectName} contract deployed`
    case ALERT_TYPES.PROJECT_CANCELLED: return `${projectName} cancelled`
    default:                            return `${projectName} updated`
  }
}

export function buildAlertMessage(type, change, project) {
  const chain = (project.chain || 'eth').toUpperCase()
  switch (type) {
    case ALERT_TYPES.PROJECT_LIVE:
      return `Mint is live on ${chain}.${project.contract_address ? ' Contract: ' + project.contract_address.slice(0, 10) + '...' : ''}`
    case ALERT_TYPES.STEALTH_DELAY:
      return `Was scheduled but hasn't gone live. Possible delay or stealth shift.`
    case ALERT_TYPES.SCHEDULE_CHANGED: {
      const oldDate = change.from ? new Date(change.from).toLocaleString() : '?'
      const newDate = change.to   ? new Date(change.to).toLocaleString()   : '?'
      return `Mint time moved from ${oldDate} to ${newDate}.`
    }
    case ALERT_TYPES.PRICE_CHANGED:
      return `Price changed from ${change.from || '?'} → ${change.to || '?'}.`
    case ALERT_TYPES.SUPPLY_CHANGED:
      return `Supply updated from ${change.from || '?'} to ${change.to || '?'}.`
    case ALERT_TYPES.CONTRACT_DEPLOYED:
      return `Contract address added: ${String(change.to || '').slice(0, 14)}...`
    case ALERT_TYPES.PROJECT_CANCELLED:
      return `Project has been cancelled.`
    default:
      return `${change.field || 'Status'}: ${change.from || '?'} → ${change.to || '?'}`
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePrice(value) {
  const s = String(value || '').trim().toLowerCase()
  if (!s) return null
  // Ignore if it looks like a contract address
  if (/^0x[0-9a-f]{40}$/.test(s)) return null
  return s
}
