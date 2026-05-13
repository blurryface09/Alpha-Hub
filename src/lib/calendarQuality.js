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
  return true
}

export function isActiveMintCalendarProject(project) {
  if (!isLaunchReadyCalendarProject(project)) return false
  const mintCount = Number(project.mint_count || 0)
  if (mintCount > 0 && project.source === 'alchemy') return true
  if (project.status === 'live') return true
  if (!project.mint_date) return false
  const date = new Date(project.mint_date).getTime()
  const now = Date.now()
  return date <= now && date > now - 12 * 60 * 60 * 1000
}

export function mintGuardEligible(project) {
  if (!project?.contract_address) return false
  return isLaunchReadyCalendarProject(project) || project.source === 'community' || project.source === 'admin'
}
