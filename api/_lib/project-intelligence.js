const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const URL_RE = /https?:\/\/[^\s<>"')]+/i
const PRICE_RE = /\b(?:price|mint price|cost)[:\s-]*([0-9]*\.?[0-9]+)\s*(?:eth|Ξ)\b/i

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

function firstUrl(rawInput) {
  const match = String(rawInput || '').match(URL_RE)
  return match?.[0] || null
}

function firstAddress(rawInput) {
  const match = String(rawInput || '').match(/0x[a-fA-F0-9]{40}/)
  return match?.[0] || null
}

function textFromMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return match[1].replace(/&amp;/g, '&').trim()
  }
  return null
}

async function fetchPageMetadata(url) {
  if (!url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'AlphaHubBot/1.0 (+https://poseidonph.com)',
        accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) return null
    const html = await response.text()
    return {
      title: textFromMeta(html, 'og:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null,
      description: textFromMeta(html, 'og:description') || textFromMeta(html, 'description'),
      imageUrl: textFromMeta(html, 'og:image') || textFromMeta(html, 'twitter:image'),
      contractAddress: firstAddress(html),
      time: detectTimeFromText(html),
      price: html.match(PRICE_RE)?.[1] || null,
      html,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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

    let collectionSlug = null
    if (host.includes('opensea')) {
      source = 'opensea'
      collectionSlug = path[path.indexOf('collection') + 1] || path[path.indexOf('assets') + 2] || path[path.length - 1]
      name = titleCase(collectionSlug || 'OpenSea Project')
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

    return { name, chain, source, mintUrl, xUrl, websiteUrl: source === 'website' ? url.href : null, sourceUrl: url.href, collectionSlug }
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

  const casual = value.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,?\s+(20\d{2}))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?(?:\s*(utc|est|edt|pst|pdt|gmt))?/i)
  if (casual) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }
    const month = months[casual[1].toLowerCase()]
    const day = Number(casual[2])
    const year = Number(casual[3] || new Date().getUTCFullYear())
    let hour = Number(casual[4] || 0)
    const minute = Number(casual[5] || 0)
    const meridiem = String(casual[6] || '').toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    const parsed = new Date(Date.UTC(year, month, day, hour, minute, 0))
    if (!Number.isNaN(parsed.getTime())) return { mintDate: parsed.toISOString(), source: 'input.date_text', confidence: 'low' }
  }

  return null
}

function confidenceLevel(score) {
  if (score >= 75) return 'high'
  if (score >= 45) return 'medium'
  return 'low'
}

function statusFromFields({ mintDate, mintEndDate, hasMintSource, mintText = '' }) {
  const text = String(mintText || '').toLowerCase()
  if (text.includes('ended') || text.includes('sold out') || text.includes('closed')) return 'ended'
  if (text.includes('tba') || text.includes('to be announced')) return 'tba'
  if (!hasMintSource || !mintDate) return 'needs_review'
  const start = new Date(mintDate).getTime()
  const end = mintEndDate ? new Date(mintEndDate).getTime() : null
  const now = Date.now()
  if (Number.isFinite(end) && end <= now) return 'ended'
  if (Number.isFinite(start) && start > now) return 'upcoming'
  if (Number.isFinite(start) && start <= now && (!end || end > now)) return 'live_now'
  return 'needs_review'
}

export async function detectProject(input = {}) {
  const raw = String(input.input || input.url || input.contractAddress || '').trim()
  const url = firstUrl(raw) || (String(input.url || '').startsWith('http') ? String(input.url).trim() : null)
  const notes = []
  const urlInfo = url ? inferFromUrl(url) : (raw && !looksLikeAddress(raw) ? inferFromUrl(raw) : null)
  const pageMeta = url ? await fetchPageMetadata(url) : null
  const contract = looksLikeAddress(raw) ? raw : (firstAddress(input.contractAddress) || firstAddress(raw) || pageMeta?.contractAddress || null)
  const chain = normalizeChain(input.chain || urlInfo?.chain || raw)
  const time = pageMeta?.time || detectTimeFromText(raw)
  const phase = normalizePhase(raw)
  const price = pageMeta?.price || raw.match(PRICE_RE)?.[1] || null
  const name = input.projectName || pageMeta?.title?.replace(/\s+-\s+OpenSea.*$/i, '').replace(/\|.*$/g, '').trim() || urlInfo?.name || (contract ? `Needs Review ${contract.slice(0, 6)}...${contract.slice(-4)}` : 'Untitled Alpha')
  const mintUrl = urlInfo?.mintUrl || url || null
  const hasMintSource = Boolean(mintUrl && !urlInfo?.xUrl)
  const mintStatus = statusFromFields({ mintDate: time?.mintDate, mintEndDate: null, hasMintSource, mintText: `${raw} ${pageMeta?.description || ''}` })
  const missingFields = []

  if (!contract) missingFields.push('contract_address')
  if (!mintUrl) missingFields.push('mint_url')
  if (!time?.mintDate) missingFields.push('mint_start_time')
  if (!phase || phase === 'unknown') missingFields.push('mint_phase')

  let confidenceScore = 20
  if (urlInfo) confidenceScore += 20
  if (pageMeta?.title || pageMeta?.description) confidenceScore += 15
  if (pageMeta?.imageUrl) confidenceScore += 10
  if (contract) confidenceScore += 20
  if (time?.mintDate) confidenceScore += time.confidence === 'high' ? 20 : time.confidence === 'medium' ? 12 : 6
  if (price) confidenceScore += 5
  confidenceScore = Math.max(0, Math.min(100, confidenceScore))
  const confidence = confidenceLevel(confidenceScore)
  const riskScore = contract && !urlInfo ? 65 : urlInfo ? 42 : 55

  if (!urlInfo && !contract) notes.push('Add an official link or contract for stronger detection.')
  if (contract && !urlInfo) notes.push('Raw contract detected. Confirm official links before Strike Mode.')
  if (!time) notes.push('Mint time was not confidently detected. Ask the user to confirm manually.')
  if (mintStatus === 'needs_review') notes.push('Needs review: missing contract, mint time, or official mint source.')
  if (chain === 'solana') notes.push('Solana is scaffolded for discovery only. Mint execution is not enabled yet.')

  console.log('Alpha intake detection', {
    source: urlInfo?.source || (contract ? 'contract' : 'text'),
    chain,
    contractFound: Boolean(contract),
    mintStatus,
    confidenceScore,
    missingFields,
  })

  return {
    ok: true,
    detected: Boolean(urlInfo || contract),
    project: {
      name,
      chain,
      chainId: chainIdFor(chain),
      contractAddress: contract,
      imageUrl: pageMeta?.imageUrl || null,
      mintUrl,
      websiteUrl: urlInfo?.websiteUrl || null,
      xUrl: urlInfo?.xUrl || null,
      sourceUrl: urlInfo?.sourceUrl || null,
      source: urlInfo?.source || (contract ? 'contract' : 'manual'),
      mintDate: time?.mintDate || null,
      mintEndDate: null,
      mintDateSource: time?.source || null,
      mintDateConfidence: time?.confidence || 'low',
      sourceTimezone: 'UTC',
      mintPhase: phase,
      mintStatus,
      recommendedMode: recommendMode(phase, riskScore),
      mintPrice: price,
      supply: null,
      riskScore,
      confidence,
      confidenceScore,
      missingFields,
      notes,
    },
  }
}
