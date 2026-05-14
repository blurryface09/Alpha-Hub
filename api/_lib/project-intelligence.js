const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

const CHAIN_IDS = {
  eth: 1,
  ethereum: 1,
  base: 8453,
  apechain: 33139,
  ape: 33139,
  solana: 0,
  sol: 0,
}

export function normalizeChain(value = '') {
  const text = String(value || '').toLowerCase()
  if (text.includes('base')) return 'base'
  if (text.includes('ape')) return 'apechain'
  if (text.includes('sol')) return 'solana'
  return 'eth'
}

export function chainIdFor(chain) {
  return CHAIN_IDS[normalizeChain(chain)] || 1
}

export function normalizePhase(value = '') {
  const text = String(value || '').toLowerCase()
  if (text.includes('gtd') || text.includes('guaranteed')) return 'gtd'
  if ((text.includes('wl') || text.includes('allow') || text.includes('white')) && text.includes('fcfs')) return 'wl_fcfs'
  if (text.includes('public') && text.includes('fcfs')) return 'public_fcfs'
  if (text.includes('allow') || text.includes('white') || /\bwl\b/.test(text)) return 'wl'
  if (text.includes('open edition') || text.includes('edition')) return 'open_edition'
  if (text.includes('claim')) return 'claim'
  if (text.includes('public')) return 'public'
  return 'unknown'
}

export function recommendMode(phase, riskScore = 50) {
  const normalized = normalizePhase(phase)
  if (riskScore >= 70 || normalized === 'unknown') return 'safe'
  if (normalized === 'wl_fcfs' || normalized === 'open_edition') return 'fast'
  if (normalized === 'public_fcfs') return 'strike'
  return 'safe'
}

export function looksLikeAddress(value) {
  return ADDRESS_RE.test(String(value || '').trim())
}

function titleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function inferFromUrl(rawInput) {
  try {
    const url = new URL(rawInput)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    const path = url.pathname.split('/').filter(Boolean)
    const joined = `${host} ${path.join(' ')}`.toLowerCase()
    const chain = joined.includes('base') ? 'base' : joined.includes('ape') ? 'apechain' : joined.includes('sol') ? 'solana' : 'eth'
    let name = ''
    let source = 'website'
    let mintUrl = url.href
    let xUrl = null

    if (host.includes('opensea')) {
      source = 'opensea'
      const slug = path[path.indexOf('collection') + 1] || path[path.length - 1]
      name = titleCase(slug || 'OpenSea Project')
    } else if (host.includes('zora')) {
      source = 'zora'
      name = titleCase(path[path.length - 1] || path[path.length - 2] || 'Zora Mint')
    } else if (host === 'x.com' || host === 'twitter.com') {
      source = 'x'
      xUrl = url.href
      mintUrl = null
      name = titleCase(path[0] || 'X Alpha Post')
    } else {
      name = titleCase(path[path.length - 1] || host.split('.')[0] || 'Mint Project')
    }

    return { name, chain, source, mintUrl, xUrl, websiteUrl: source === 'website' ? url.href : null, sourceUrl: url.href }
  } catch {
    return null
  }
}

function detectTimeFromText(text) {
  const value = String(text || '')
  const iso = value.match(/\b20\d{2}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/)
  if (iso) {
    const parsed = new Date(iso[0])
    if (!Number.isNaN(parsed.getTime())) return { mintDate: parsed.toISOString(), source: 'input.iso_date', confidence: 'medium' }
  }

  const casual = value.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*20\d{2})?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i)
  if (casual) {
    const parsed = new Date(casual[0])
    if (!Number.isNaN(parsed.getTime())) return { mintDate: parsed.toISOString(), source: 'input.date_text', confidence: 'low' }
  }

  return null
}

export async function detectProject(input = {}) {
  const raw = String(input.input || input.url || input.contractAddress || '').trim()
  const notes = []
  const urlInfo = raw && !looksLikeAddress(raw) ? inferFromUrl(raw) : null
  const contract = looksLikeAddress(raw) ? raw : (String(input.contractAddress || '').match(/0x[a-fA-F0-9]{40}/)?.[0] || null)
  const chain = normalizeChain(input.chain || urlInfo?.chain || raw)
  const time = detectTimeFromText(raw)
  const phase = normalizePhase(raw)
  const riskScore = contract && !urlInfo ? 65 : urlInfo ? 42 : 55

  if (!urlInfo && !contract) notes.push('Add an official link or contract for stronger detection.')
  if (contract && !urlInfo) notes.push('Raw contract detected. Confirm official links before Strike Mode.')
  if (!time) notes.push('Mint time was not confidently detected. Ask the user to confirm manually.')
  if (chain === 'solana') notes.push('Solana is scaffolded for discovery only. Mint execution is not enabled yet.')

  return {
    ok: true,
    detected: Boolean(urlInfo || contract),
    project: {
      name: input.projectName || urlInfo?.name || (contract ? `NFT Contract ${contract.slice(0, 6)}...${contract.slice(-4)}` : 'Untitled Alpha'),
      chain,
      chainId: chainIdFor(chain),
      contractAddress: contract,
      imageUrl: null,
      mintUrl: urlInfo?.mintUrl || null,
      websiteUrl: urlInfo?.websiteUrl || null,
      xUrl: urlInfo?.xUrl || null,
      sourceUrl: urlInfo?.sourceUrl || null,
      source: urlInfo?.source || (contract ? 'contract' : 'manual'),
      mintDate: time?.mintDate || null,
      mintDateSource: time?.source || null,
      mintDateConfidence: time?.confidence || 'low',
      sourceTimezone: 'UTC',
      mintPhase: phase,
      recommendedMode: recommendMode(phase, riskScore),
      mintPrice: null,
      supply: null,
      riskScore,
      confidence: urlInfo && contract ? 'high' : urlInfo ? 'medium' : contract ? 'low' : 'low',
      notes,
    },
  }
}
