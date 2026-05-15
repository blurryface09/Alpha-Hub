const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function isAddressLikeName(value) {
  const text = String(value || '').trim()
  const lower = text.toLowerCase()
  if (!text) return true
  if (ADDRESS_RE.test(text)) return true
  if (/0x[a-f0-9]{8,}/i.test(text)) return true
  if (lower.startsWith('detected mint')) return true
  if (lower.startsWith('new nft contract')) return true
  if (lower.startsWith('nft contract 0x')) return true
  if (['unknown', 'untitled', 'contract', 'nft contract'].includes(lower)) return true
  return false
}

export function hasUsefulProjectName(project) {
  const name = String(project?.name || '').trim()
  return name.length >= 3 && !isAddressLikeName(name)
}

export function hasMetadataLink(project) {
  return Boolean(project?.image_url || project?.website_url || project?.mint_url || project?.source_url)
}

export function calendarQualityScore(project) {
  if (!project) return 0
  const checks = [
    hasUsefulProjectName(project),
    Boolean(project.image_url),
    Boolean(project.mint_url || project.website_url),
    ['opensea', 'alchemy', 'zora', 'community', 'admin'].includes(project.source),
    Boolean(project.contract_address),
    Boolean(project.mint_date || project.mint_status === 'live_now' || project.mint_status === 'upcoming'),
    Boolean(project.slug && !isAddressLikeName(project.slug)),
    Boolean(project.x_url || project.discord_url),
    Boolean(project.source_url),
  ]
  const passed = checks.filter(Boolean).length
  const base = Math.round((passed / checks.length) * 100)
  const sourceBonus = project.source === 'admin' || project.source === 'community'
    ? 12
    : project.source === 'opensea' || project.source === 'alchemy'
    ? 8
    : project.source === 'zora'
    ? 6
    : 0
  const rawPenalty = isAddressLikeName(project.name) || project.source === 'onchain' ? 25 : 0
  return Math.max(0, Math.min(100, base + sourceBonus - rawPenalty))
}

export function isRawCalendarDiscovery(project) {
  if (!project) return true
  if (project.source === 'onchain') return true
  if (!hasUsefulProjectName(project)) return true
  if (!hasMetadataLink(project) && project.source !== 'alchemy') return true
  return false
}

export function isLaunchReadyCalendarProject(project) {
  if (!project) return false
  if (['hidden', 'rejected', 'pending_review'].includes(project.status)) return false
  if (isRawCalendarDiscovery(project)) return false
  if (project.source_confidence === 'low') return false
  if (calendarQualityScore(project) < 50) return false
  return true
}

export function isActiveMintCalendarProject(project) {
  if (!isLaunchReadyCalendarProject(project)) return false
  const quality = calendarQualityScore(project)
  const confidence = project.mint_date_confidence || project.source_confidence || 'low'
  // Only trusted sources may use 'medium' confidence as confirmed
  const trustedSource = ['opensea', 'alchemy', 'admin', 'community'].includes(project.source)
  const highConf   = ['high', 'manual', 'confirmed'].includes(confidence)
  const medTrusted = confidence === 'medium' && trustedSource
  const confirmed  = highConf || medTrusted
  if (project.mint_status === 'live_now' && confirmed && quality >= 60) return true
  if (project.status === 'live' && project.mint_date && confirmed && quality >= 60) return true
  if (!project.mint_date) return false
  const date = new Date(project.mint_date).getTime()
  const now = Date.now()
  return confirmed && date <= now && date > now - 12 * 60 * 60 * 1000
}

export function computeDisplayStatus(project) {
  if (!project) return 'tba'
  if (['hidden', 'rejected'].includes(project.status)) return 'hidden'
  if (project.mint_status === 'ended' || project.status === 'ended') return 'ended'
  const confidence = project.mint_date_confidence || project.source_confidence || 'low'
  const trustedSource = ['opensea', 'alchemy', 'admin', 'community'].includes(project.source)
  const confirmed = ['high', 'manual', 'confirmed'].includes(confidence) || (confidence === 'medium' && trustedSource)
  if (project.mint_status === 'live_now') return 'live_now'
  if (project.status === 'live' && confirmed) return 'live_now'
  if (project.mint_date) {
    const date = new Date(project.mint_date).getTime()
    const now = Date.now()
    if (confirmed && date <= now && date > now - 12 * 60 * 60 * 1000) return 'live_now'
    if (date > now) return 'upcoming'
    return 'needs_review'
  }
  if (!hasUsefulProjectName(project) || !project.contract_address) return 'needs_review'
  return 'tba'
}

export function computeProjectBadges(project) {
  if (!project) return []
  const badges = []
  const displayStatus = computeDisplayStatus(project)
  if (displayStatus === 'live_now')  badges.push({ id: 'live',          label: 'Live Now',        cls: 'badge-green animate-pulse-slow' })
  if (displayStatus === 'upcoming')  badges.push({ id: 'upcoming',      label: 'Upcoming',         cls: 'badge-yellow' })
  if (displayStatus === 'ended')     badges.push({ id: 'ended',         label: 'Ended',            cls: 'badge-cyan'   })
  if (displayStatus === 'tba')       badges.push({ id: 'tba',           label: 'TBA',              cls: 'badge-cyan'   })
  if (!project.contract_address)     badges.push({ id: 'needs_contract',label: 'Needs Contract',   cls: 'badge-red'    })
  if (project.contract_address && !project.mint_date)
                                     badges.push({ id: 'needs_time',    label: 'Needs Time',       cls: 'badge-yellow' })
  if (project.notes?.includes('Needs review'))
                                     badges.push({ id: 'needs_review',  label: 'Needs Review',     cls: 'badge-yellow' })
  return badges
}

export function strikeBlockers(project) {
  const blockers = []
  if (!project?.contract_address) blockers.push('Contract address required')
  if (!project?.mint_date) blockers.push('Mint date/time required')
  const confidence = project?.mint_date_confidence || project?.source_confidence || 'low'
  const trustedSource = ['opensea', 'alchemy', 'admin', 'community'].includes(project?.source)
  const confirmed = ['high', 'manual', 'confirmed'].includes(confidence) || (confidence === 'medium' && trustedSource)
  if (!confirmed) blockers.push('Mint time not verified — confirm before enabling Strike Mode')
  return blockers
}

export function mintGuardEligible(project) {
  if (!project?.contract_address) return false
  if (['community', 'admin'].includes(project.source) && hasUsefulProjectName(project)) return true
  return isLaunchReadyCalendarProject(project) && calendarQualityScore(project) >= 50
}
