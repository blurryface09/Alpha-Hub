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
    Boolean(project.mint_date || Number(project.mint_count || 0) > 0 || project.status === 'live'),
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
  const mintCount = Number(project.mint_count || 0)
  if (mintCount > 0 && project.source === 'alchemy' && quality >= 50) return true
  if (project.status === 'live') return true
  if (!project.mint_date) return false
  const date = new Date(project.mint_date).getTime()
  const now = Date.now()
  return date <= now && date > now - 12 * 60 * 60 * 1000
}

export function mintGuardEligible(project) {
  if (!project?.contract_address) return false
  if (['community', 'admin'].includes(project.source) && hasUsefulProjectName(project)) return true
  return isLaunchReadyCalendarProject(project) && calendarQualityScore(project) >= 50
}
