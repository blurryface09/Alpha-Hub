// Canonical project status normalization — single source of truth.
// Priority: admin/hidden > live_now protection > time-window live > incoming state > fallback
//
// All writes to calendar_projects.status / mint_status must go through here.

export function normalizeProjectState(project, { source = 'unknown', existing = null } = {}) {
  const now = Date.now()
  const mintStart = project.mint_date     ? new Date(project.mint_date).getTime()     : null
  const mintEnd   = project.mint_end_date ? new Date(project.mint_end_date).getTime() : null

  let mintStatus     = project.mint_status || null
  const incomingStatus = project.status   || null

  // Rule 1 — time-window upgrade: mint started and not yet ended → live_now.
  // Never overwrite an explicit live_now or ended with a time check.
  if (mintStatus !== 'live_now' && mintStatus !== 'ended') {
    if (mintStart && mintStart <= now && (mintEnd == null || mintEnd > now)) {
      mintStatus = 'live_now'
    }
  }

  // Rule 2 — time-based ended: mint_end_date passed and not explicitly live_now.
  if (mintEnd && mintEnd <= now && mintStatus !== 'live_now') {
    mintStatus = 'ended'
  }

  // Rule 3 — protect existing live_now from being overwritten by weaker sync data.
  // Only allow downgrade to 'ended'.
  if (existing?.mint_status === 'live_now' && mintStatus !== 'ended') {
    mintStatus = 'live_now'
  }

  // Derive canonical DB status.
  const adminLocked = ['hidden', 'rejected'].includes(existing?.status)
  let status = incomingStatus

  if (adminLocked) {
    status = existing.status
  } else if (mintStatus === 'live_now') {
    status = 'live'
  } else if (mintStatus === 'ended') {
    status = 'ended'
  } else if (!status) {
    status = project.mint_date ? 'approved' : 'pending_review'
  }

  // Telemetry — only log when something actually changed.
  const prevStatus     = existing?.status      || null
  const prevMintStatus = existing?.mint_status  || null
  if (prevStatus !== status || prevMintStatus !== mintStatus) {
    const reason =
      adminLocked                                                             ? 'protected_admin'
      : mintStatus === 'live_now' && prevMintStatus !== 'live_now' && mintStart && mintStart <= now
                                                                              ? 'time_window_live'
      : existing?.mint_status === 'live_now' && mintStatus === 'live_now'   ? 'protected_live'
      : mintStatus === 'ended'                                               ? 'time_ended'
      :                                                                        'incoming_state'
    console.log('[project-normalize]', {
      source,
      contract:         (project.contract_address || '').slice(0, 10) || null,
      prev_status:      prevStatus,
      new_status:       status,
      prev_mint_status: prevMintStatus,
      new_mint_status:  mintStatus,
      overwrite_reason: reason,
    })
  }

  return { status, mint_status: mintStatus }
}

// Quick check: is this project live right now by canonical rules?
export function isProjectLiveNow(project, existing = null) {
  const { mint_status, status } = normalizeProjectState(project, { existing })
  return mint_status === 'live_now' || status === 'live'
}
