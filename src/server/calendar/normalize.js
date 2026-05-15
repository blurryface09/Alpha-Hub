const CHAIN_IDS = { eth: 1, ethereum: 1, base: 8453, bnb: 56, bsc: 56, zora: 7777777 }

export function normalizeChain(value) {
  const chain = String(value || 'eth').toLowerCase()
  if (chain.includes('base')) return 'base'
  if (chain.includes('bnb') || chain.includes('bsc')) return 'bnb'
  if (chain.includes('zora')) return 'zora'
  return 'eth'
}

export function chainIdFor(value) {
  return CHAIN_IDS[normalizeChain(value)] || 1
}

export function normalizeAddress(value) {
  const address = String(value || '').trim()
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : null
}

export function slugify(value) {
  return String(value || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

export function shareSlug(value) {
  return slugify(value).slice(0, 48) || 'project'
}

export function shareCode(value, contractAddress) {
  const clean = slugify(value).replace(/-/g, '').slice(0, 8).toUpperCase()
  if (clean.length >= 4) return `AH-${clean}`
  const fallback = String(contractAddress || Math.random().toString(36).slice(2, 8))
    .replace(/^0x/i, '')
    .slice(0, 6)
    .toUpperCase()
  return `AH-${fallback || 'MINT'}`
}

export function normalizeProject(input, source) {
  const chain = normalizeChain(input.chain)
  const name = String(input.name || input.slug || input.contract_address || 'Detected NFT Project').trim()
  const contract = normalizeAddress(input.contract_address)
  const now = new Date().toISOString()

  return {
    name,
    slug: input.slug || slugify(name),
    image_url: input.image_url || null,
    description: input.description || null,
    chain,
    chain_id: Number(input.chain_id || chainIdFor(chain)),
    contract_address: contract,
    mint_url: input.mint_url || null,
    website_url: input.website_url || null,
    x_url: input.x_url || null,
    discord_url: input.discord_url || null,
    mint_date: input.mint_date || null,
    mint_date_source: input.mint_date_source || null,
    mint_date_confidence: input.mint_date_confidence || (input.mint_date ? 'medium' : 'low'),
    mint_time_confirmed: Boolean(input.mint_time_confirmed),
    mint_price: input.mint_price || null,
    mint_type: input.mint_type || 'unknown',
    status: input.status || (input.mint_date && new Date(input.mint_date) <= new Date() ? 'live' : 'approved'),
    mint_status: input.mint_status || null,
    mint_end_date: input.mint_end_date || null,
    source,
    source_url: input.source_url || input.mint_url || input.website_url || null,
    source_confidence: input.source_confidence || (contract ? 'medium' : 'low'),
    source_metadata: input.source_metadata || null,
    risk_score: Number.isFinite(input.risk_score) ? input.risk_score : null,
    hype_score: Number(input.hype_score || 0),
    whale_interest_score: Number(input.whale_interest_score || 0),
    hidden_gem_score: Number(input.hidden_gem_score || 0),
    holder_count: Number.isFinite(input.holder_count) ? input.holder_count : null,
    mint_count: Number(input.mint_count || 0),
    tracked_wallet_count: Number(input.tracked_wallet_count || 0),
    quality_score: Number(input.quality_score || 0),
    rating_avg: Number(input.rating_avg || 0),
    rating_count: Number(input.rating_count || 0),
    share_code: input.share_code || shareCode(name, contract),
    share_slug: input.share_slug || shareSlug(name),
    submitted_by_user_id: input.submitted_by_user_id || input.created_by || null,
    submitted_by_wallet: input.submitted_by_wallet || input.created_by_wallet || null,
    submitter_role: input.submitter_role || null,
    community_name: input.community_name || null,
    community_x_handle: input.community_x_handle || null,
    submitted_by_label: input.submitted_by_label || input.community_name || input.community_x_handle || null,
    first_seen_at: input.first_seen_at || now,
    last_seen_at: input.last_seen_at || now,
    last_synced_at: now,
    updated_at: now,
  }
}

export function dedupeKey(project) {
  if (project.contract_address) return `${project.chain}:${project.contract_address}`
  if (project.source_url) return `${project.source}:${project.source_url}`.toLowerCase()
  return `${project.source}:${project.slug}`.toLowerCase()
}
