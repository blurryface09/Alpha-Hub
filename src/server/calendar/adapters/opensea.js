import { normalizeProject } from '../normalize.js'
import { isAddressLikeName } from '../../../lib/calendarQuality.js'

const OPENSEA_BASE = 'https://api.opensea.io/api/v2'
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map()

function cleanCollectionName(collection) {
  const name = String(collection?.name || collection?.collection || collection?.slug || '').trim()
  if (!name || isAddressLikeName(name)) return null
  if (name.length < 3) return null
  return name
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { ts: Date.now(), value })
  return value
}

async function openSeaJson(path, { searchParams = {} } = {}) {
  const apiKey = process.env.OPENSEA_API_KEY
  if (!apiKey) throw new Error('OPENSEA_API_KEY missing')
  const url = new URL(path.startsWith('http') ? path : `${OPENSEA_BASE}${path}`)
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const cacheKey = url.toString()
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const response = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8500),
  })
  if (!response.ok) throw new Error(`OpenSea ${response.status}`)
  return cacheSet(cacheKey, await response.json())
}

function primaryContract(record) {
  const contracts = [
    ...(Array.isArray(record?.contracts) ? record.contracts : []),
    ...(Array.isArray(record?.collection?.contracts) ? record.collection.contracts : []),
    record?.contract,
    record?.primary_asset_contract,
  ].filter(Boolean)
  const contract = contracts.find(item => item?.address || item?.contract_address)
  if (!contract && (record?.contract_address || record?.contractAddress)) {
    return { address: record.contract_address || record.contractAddress, chain: record.chain }
  }
  return contract || null
}

function parseDate(value) {
  if (!value) return null
  if (typeof value === 'number') {
    const date = new Date(value < 1e12 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

const PRICE_FIELD_HINTS = [
  'price', 'mint_price', 'mintPrice', 'price_per_token', 'pricePerToken',
  'native_price', 'nativePrice', 'publicSalePrice', 'presalePrice',
  'allowlistPrice', 'sale_config', 'saleConfig', 'payment', 'payment_token',
  'paymentToken', 'currency', 'token', 'cost', 'amount',
]

const TIME_START_HINTS = [
  'start_date', 'startDate', 'start_time', 'startTime', 'starts_at',
  'startsAt', 'mint_start_time', 'mintStartTime', 'publicSaleStart',
  'publicSaleStartTime', 'saleStart', 'saleStartTime', 'presaleStart',
  'presaleStartTime', 'allowlistStart', 'allowlistStartTime', 'start',
]

const TIME_END_HINTS = [
  'end_date', 'endDate', 'end_time', 'endTime', 'ends_at', 'endsAt',
  'mint_end_time', 'mintEndTime', 'publicSaleEnd', 'publicSaleEndTime',
  'saleEnd', 'saleEndTime', 'presaleEnd', 'presaleEndTime', 'allowlistEnd',
  'allowlistEndTime', 'end',
]

const LIMIT_HINTS = [
  'wallet_limit', 'walletLimit', 'per_wallet_limit', 'perWalletLimit',
  'max_per_wallet', 'maxPerWallet', 'maxMintPerWallet', 'max_mint_per_wallet',
  'limit_per_wallet', 'limitPerWallet',
]

const ELIGIBILITY_HINTS = [
  'eligibility', 'eligibility_label', 'eligibilityLabel', 'allowlist',
  'requirements', 'criteria', 'proof', 'merkle', 'access_list',
]

function decodeEntities(value = '') {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function stripHtml(html = '') {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
}

function keyMatches(key, hints) {
  const clean = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  return hints.some(hint => clean === hint.replace(/[^a-z0-9]/gi, '').toLowerCase())
}

function pathHasRejectedPriceMeaning(path = '') {
  return /(floor|floorprice|totalvolume|volume|gas|fee|listing|secondary|royalty|marketcap|salevolume)/i.test(path)
}

function normalizeCurrency(value, fallback = 'ETH') {
  const text = String(value || '').toUpperCase()
  if (text.includes('SOL')) return 'SOL'
  if (text.includes('MATIC') || text.includes('POL')) return 'MATIC'
  if (text.includes('WETH')) return 'WETH'
  if (text.includes('APE')) return 'APE'
  if (text.includes('BNB')) return 'BNB'
  if (text.includes('ETH') || text.includes('Ξ')) return 'ETH'
  return fallback
}

function formatPrice(value, currency = 'ETH') {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  if (numeric === 0) return 'Free mint'
  return `${numeric.toString()} ${currency}`
}

function parsePriceCandidate(value, { path = '', context = '', currency = null } = {}) {
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
  const joined = `${path} ${context} ${raw}`
  if (!raw || raw === 'null' || raw === 'undefined') return null
  if (pathHasRejectedPriceMeaning(joined)) {
    return { rejected: true, raw, source_path: path, reason: 'secondary_or_non_mint_price' }
  }
  if (/\b(to be announced|tba|not announced)\b/i.test(joined)) {
    return {
      price_value: null,
      price_currency: null,
      price_label: 'Price TBA',
      price_note: 'OpenSea marked the mint price as TBA.',
      price_confidence: 'medium',
      raw,
      source_path: path,
    }
  }
  if (/\b(free mint|free)\b/i.test(joined) || /(^|[^0-9.])0(?:\.0+)?\s*(eth|Ξ|sol|matic|bnb|ape)\b/i.test(joined) || /^0(?:\.0+)?$/.test(raw.trim())) {
    return {
      price_value: 0,
      price_currency: normalizeCurrency(joined, currency || 'ETH'),
      price_label: 'Free mint',
      price_note: 'Detected free mint price.',
      price_confidence: 'high',
      raw,
      source_path: path,
    }
  }
  const objectValue = typeof value === 'object' && value
    ? firstDefined(value.quantity, value.amount, value.value, value.eth, value.native, value.decimal, value.price)
    : null
  const objectCurrency = typeof value === 'object' && value
    ? firstDefined(value.symbol, value.currency, value.token, value.name, value.payment_token?.symbol, value.paymentToken?.symbol)
    : null
  const candidateText = objectValue !== null && objectValue !== undefined ? String(objectValue) : joined
  const explicit = candidateText.match(/([0-9]+(?:\.[0-9]+)?)\s*(Ξ|ETH|WETH|SOL|MATIC|POL|BNB|APE)\b/i)
  const labeled = joined.match(/\b(?:mint price|price|cost|sale price)[:\s-]*([0-9]+(?:\.[0-9]+)?)\s*(Ξ|ETH|WETH|SOL|MATIC|POL|BNB|APE)?\b/i)
  const numberOnly = path && keyMatches(path.split('.').pop(), PRICE_FIELD_HINTS)
    ? String(candidateText).match(/^([0-9]+(?:\.[0-9]+)?)$/)
    : null
  const match = explicit || labeled || numberOnly
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  if (amount > 10000 && !explicit && !labeled) return null
  const detectedCurrency = normalizeCurrency(match[2] || objectCurrency || joined, currency || 'ETH')
  return {
    price_value: amount,
    price_currency: detectedCurrency,
    price_label: formatPrice(amount, detectedCurrency),
    price_note: 'Detected mint price from OpenSea schedule data.',
    price_confidence: explicit || labeled ? 'high' : 'medium',
    raw,
    source_path: path,
  }
}

function timezoneOffsetMinutes(value = '') {
  const text = String(value || '').trim().toUpperCase()
  if (!text) return null
  if (text === 'UTC' || text === 'GMT') return 0
  const gmt = text.match(/^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/)
  if (gmt) {
    const sign = gmt[1] === '+' ? 1 : -1
    return sign * ((Number(gmt[2]) * 60) + Number(gmt[3] || 0))
  }
  const abbreviations = {
    EST: -300,
    EDT: -240,
    PST: -480,
    PDT: -420,
    CET: 60,
    CEST: 120,
    WET: 0,
    BST: 60,
  }
  return abbreviations[text] ?? null
}

function parseDateWithTimezone(value) {
  if (!value) return { iso: null, timezone: null, raw: null }
  if (typeof value === 'number') return { iso: parseDate(value), timezone: 'UTC', raw: value }
  const raw = decodeEntities(String(value).trim())
  const timezone = raw.match(/\b(UTC|GMT[+-]?\d{0,2}(?::?\d{2})?|EST|EDT|PST|PDT|CET|CEST|WET|BST)\b/i)?.[1] || null
  const direct = parseDate(raw)
  if (direct) return { iso: direct, timezone: timezone || (/[zZ]|[+-]\d{2}:?\d{2}/.test(raw) ? 'UTC' : null), raw }
  const month = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,?\s+(20\d{2}))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?(?:\s*(UTC|GMT[+-]?\d{0,2}(?::?\d{2})?))?/i)
  if (!month) return { iso: null, timezone, raw }
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }
  let hour = Number(month[4] || 0)
  const minute = Number(month[5] || 0)
  const meridiem = String(month[6] || '').toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  const year = Number(month[3] || new Date().getUTCFullYear())
  const parsedTimezone = month[7] || timezone || 'UTC'
  const offset = timezoneOffsetMinutes(parsedTimezone) || 0
  const parsed = new Date(Date.UTC(year, months[month[1].toLowerCase()], Number(month[2]), hour, minute) - (offset * 60 * 1000))
  return { iso: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(), timezone: parsedTimezone, raw }
}

function inferStageName(source = {}) {
  const value = firstDefined(
    source.stage_name, source.stageName, source.name, source.label, source.phase,
    source.stage_type, source.stageType, source.sale_type, source.saleType,
    source.kind, source.type, source.access_type, source.accessType
  )
  return value ? String(value).trim() : null
}

function normalizeStageName(value, index = 0) {
  const text = String(value || '').trim()
  if (!text) return `Stage ${index + 1}`
  if (/allow|white|wl/i.test(text)) return /fcfs/i.test(text) ? 'WL FCFS' : 'Allowlist'
  if (/presale/i.test(text)) return 'Presale'
  if (/public/i.test(text)) return /fcfs/i.test(text) ? 'Public FCFS' : 'Public'
  if (/gtd|guaranteed/i.test(text)) return 'GTD'
  if (/open edition/i.test(text)) return 'Open Edition'
  if (/claim/i.test(text)) return 'Claim'
  return text.replace(/[_-]+/g, ' ')
}

function accessTypeFromText(value = '') {
  const text = String(value || '').toLowerCase()
  if (text.includes('gtd') || text.includes('guaranteed')) return 'GTD'
  if ((text.includes('allow') || text.includes('white') || /\bwl\b/.test(text)) && text.includes('fcfs')) return 'WL FCFS'
  if (text.includes('allow') || text.includes('white') || text.includes('presale') || /\bwl\b/.test(text)) return 'Presale/WL'
  if (text.includes('public') && text.includes('fcfs')) return 'Public FCFS'
  if (text.includes('open edition')) return 'Open Edition'
  if (text.includes('claim')) return 'Claim'
  if (text.includes('public')) return 'Public'
  if (text.includes('fcfs')) return 'FCFS'
  return 'Unknown'
}

function walk(value, callback, path = '$', depth = 0, seen = new Set()) {
  if (depth > 9 || value === null || value === undefined) return
  if (typeof value !== 'object') {
    callback(value, path)
    return
  }
  if (seen.has(value)) return
  seen.add(value)
  callback(value, path)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, callback, `${path}[${index}]`, depth + 1, seen))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    walk(child, callback, `${path}.${key}`, depth + 1, seen)
  }
}

function valuesByHints(object, hints) {
  const values = []
  if (!object || typeof object !== 'object') return values
  for (const [key, value] of Object.entries(object)) {
    if (keyMatches(key, hints)) values.push({ key, value })
  }
  return values
}

function isStageLikeObject(object, path = '') {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false
  const keys = Object.keys(object)
  const hasTime = keys.some(key => keyMatches(key, TIME_START_HINTS) || keyMatches(key, TIME_END_HINTS))
  const hasPrice = keys.some(key => keyMatches(key, PRICE_FIELD_HINTS))
  const hasName = keys.some(key => /stage|phase|sale|allow|public|presale|claim|name|label|type/i.test(key))
  const pathHint = /(stage|phase|sale|drop|mint)/i.test(path)
  return (hasTime && (hasPrice || hasName || pathHint)) || (hasPrice && hasName && pathHint)
}

function stageStatus(stage, text = '') {
  const raw = `${stage.status || ''} ${stage.state || ''} ${text}`.toLowerCase()
  if (/(sold out|ended|closed|complete|finished)/.test(raw)) return 'ended'
  if (/\b(tba|to be announced)\b/.test(raw)) return 'tba'
  if (/(minting in|starts in|countdown)/.test(raw)) return 'upcoming'
  if (/(minting now|mint now|mint is live|mint open|live now)/.test(raw)) return 'live_now'
  const startMs = stage.start_time ? new Date(stage.start_time).getTime() : null
  const endMs = stage.end_time ? new Date(stage.end_time).getTime() : null
  const now = Date.now()
  if (endMs && endMs <= now) return 'ended'
  if (startMs && startMs > now) return 'upcoming'
  if (startMs && startMs <= now && (!endMs || endMs > now)) return 'live_now'
  return 'needs_review'
}

function normalizeStage(object, path, index = 0) {
  const name = normalizeStageName(inferStageName(object), index)
  const textContext = JSON.stringify(object).slice(0, 2000)
  const start = valuesByHints(object, TIME_START_HINTS)
    .map(item => parseDateWithTimezone(item.value))
    .find(item => item.iso)
  const end = valuesByHints(object, TIME_END_HINTS)
    .map(item => parseDateWithTimezone(item.value))
    .find(item => item.iso)
  let price = null
  const rejected = []
  for (const item of valuesByHints(object, PRICE_FIELD_HINTS)) {
    const parsed = parsePriceCandidate(item.value, { path: `${path}.${item.key}`, context: textContext })
    if (parsed?.rejected) rejected.push(parsed)
    else if (parsed && !price) price = parsed
  }
  const limit = valuesByHints(object, LIMIT_HINTS).map(item => item.value).find(Boolean)
  const eligibility = valuesByHints(object, ELIGIBILITY_HINTS)
    .map(item => typeof item.value === 'string' ? item.value : item.key)
    .find(Boolean)
  const stage = {
    stage_name: name,
    access_type: accessTypeFromText(`${name} ${textContext}`),
    status: 'needs_review',
    start_time: start?.iso || null,
    end_time: end?.iso || null,
    timezone: start?.timezone || end?.timezone || null,
    price_value: price?.price_value ?? null,
    price_currency: price?.price_currency || null,
    price_label: price?.price_label || null,
    price_note: price?.price_note || null,
    price_confidence: price?.price_confidence || 'low',
    wallet_limit: limit === undefined || limit === null ? null : String(limit),
    eligibility: eligibility ? String(eligibility) : null,
    raw_source_path: path,
    raw_price_text: price?.raw || null,
    rejected_price_candidates: rejected,
  }
  stage.status = stageStatus(stage, textContext)
  return stage
}

function extractJsonPayloads(html = '') {
  const payloads = []
  const next = String(html).match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (next?.[1]) {
    try { payloads.push(JSON.parse(decodeEntities(next[1]))) } catch {}
  }
  const scriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = scriptRegex.exec(String(html))) && payloads.length < 12) {
    try { payloads.push(JSON.parse(decodeEntities(match[1]))) } catch {}
  }
  return payloads
}

function extractTextStages(html = '') {
  const text = stripHtml(html)
  if (!text) return []
  const stages = []
  const stageLine = /\b(allowlist|whitelist|wl fcfs|wl|presale|public fcfs|public|gtd|guaranteed|open edition|claim)\b[\s\S]{0,160}?\b(?:mint price|price|cost)?[:\s-]*(free mint|free|[0-9]+(?:\.[0-9]+)?\s*(?:ETH|WETH|SOL|MATIC|POL|BNB|APE|Ξ)|TBA|to be announced)?[\s\S]{0,220}?(?:starts?:?\s*([^;|]+?))?(?:\s+ends?:?\s*([^;|]+?))?(?:$)/gi
  let match
  while ((match = stageLine.exec(text)) && stages.length < 12) {
    const context = match[0]
    const price = parsePriceCandidate(match[2] || context, { path: '$.html.text', context })
    const start = parseDateWithTimezone(match[3] || context.match(/\b(?:starts?|minting begins?)[:\s-]*([^.;|]+)/i)?.[1])
    const end = parseDateWithTimezone(match[4] || context.match(/\bends?[:\s-]*([^.;|]+)/i)?.[1])
    const limit = context.match(/\b(?:limit|per wallet|wallet limit)[:\s-]*([0-9]+)\b/i)?.[1] || null
    const stage = {
      stage_name: normalizeStageName(match[1], stages.length),
      access_type: accessTypeFromText(match[1]),
      status: 'needs_review',
      start_time: start.iso,
      end_time: end.iso,
      timezone: start.timezone || end.timezone,
      price_value: price?.price_value ?? null,
      price_currency: price?.price_currency || null,
      price_label: price?.price_label || null,
      price_note: price?.price_note || null,
      price_confidence: price?.price_confidence || 'low',
      wallet_limit: limit,
      eligibility: /\b(allowlist|whitelist|eligible|holder|token gated)\b/i.test(context) ? 'Eligibility shown on page' : null,
      raw_source_path: '$.html.text',
      raw_price_text: price?.raw || null,
      rejected_price_candidates: price?.rejected ? [price] : [],
    }
    stage.status = stageStatus(stage, context)
    if (stage.price_label || stage.start_time || /minting in|mint now|sold out|ended|closed/i.test(context)) stages.push(stage)
  }
  if (!stages.length) {
    const statusText = text.match(/\b(minting in[^.]{0,80}|minting now|mint now|mint is live|sold out|ended|closed)\b/i)?.[0]
    const price = parsePriceCandidate(text.match(/\b(?:mint price|price|cost)[:\s-]*(free|[0-9]+(?:\.[0-9]+)?\s*(?:ETH|WETH|SOL|MATIC|POL|BNB|APE|Ξ)|TBA|to be announced)/i)?.[1], { path: '$.html.text', context: text.slice(0, 1000) })
    if (statusText || price) {
      const stage = {
        stage_name: 'Mint Schedule',
        access_type: accessTypeFromText(text),
        status: 'needs_review',
        start_time: null,
        end_time: null,
        timezone: null,
        price_value: price?.price_value ?? null,
        price_currency: price?.price_currency || null,
        price_label: price?.price_label || null,
        price_note: price?.price_note || (/minting in/i.test(statusText || '') ? 'Only countdown detected.' : null),
        price_confidence: price?.price_confidence || 'low',
        wallet_limit: text.match(/\b(?:limit|per wallet|wallet limit)[:\s-]*([0-9]+)\b/i)?.[1] || null,
        eligibility: null,
        raw_source_path: '$.html.text',
        raw_price_text: price?.raw || null,
        rejected_price_candidates: [],
      }
      stage.status = stageStatus(stage, statusText || text.slice(0, 600))
      stages.push(stage)
    }
  }
  return stages
}

function dedupeStages(stages) {
  const seen = new Set()
  return stages.filter(stage => {
    const key = `${stage.stage_name}|${stage.start_time}|${stage.end_time}|${stage.price_label}|${stage.raw_source_path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function selectStages(stages) {
  const sorted = [...stages].sort((a, b) => {
    const at = a.start_time ? new Date(a.start_time).getTime() : Number.MAX_SAFE_INTEGER
    const bt = b.start_time ? new Date(b.start_time).getTime() : Number.MAX_SAFE_INTEGER
    return at - bt
  })
  const current = sorted.find(stage => stage.status === 'live_now') || null
  const next = sorted.find(stage => stage.status === 'upcoming') || null
  const selected = current || next || sorted[0] || null
  let status = selected?.status || 'needs_review'
  if (!current && !next && sorted.length && sorted.every(stage => stage.status === 'ended')) status = 'ended'
  return { sorted, current, next, selected, status }
}

export function extractOpenSeaSchedule(record = {}, { html = '', url = null, slug = null } = {}) {
  const objectStages = []
  const rejectedPriceCandidates = []
  const roots = [record, ...extractJsonPayloads(html)]
  roots.forEach((root, rootIndex) => {
    walk(root, (value, path) => {
      const lastKey = path.split('.').pop()
      if ((typeof value !== 'object' || value === null) && (keyMatches(lastKey, PRICE_FIELD_HINTS) || pathHasRejectedPriceMeaning(path))) {
        const parsed = parsePriceCandidate(value, { path: `$root${rootIndex}${path.slice(1)}` })
        if (parsed?.rejected) rejectedPriceCandidates.push(parsed)
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && isStageLikeObject(value, path)) {
        const stage = normalizeStage(value, `$root${rootIndex}${path.slice(1)}`, objectStages.length)
        rejectedPriceCandidates.push(...(stage.rejected_price_candidates || []))
        if (stage.start_time || stage.end_time || stage.price_label || /stage|phase|sale/i.test(path)) objectStages.push(stage)
      }
    })
  })
  const textStages = extractTextStages(html)
  const stages = dedupeStages([...objectStages, ...textStages]).slice(0, 24)
  const { sorted, current, next, selected, status } = selectStages(stages)
  const stagePrices = sorted
    .filter(stage => stage.price_label)
    .map(stage => ({
      stage_name: stage.stage_name,
      access_type: stage.access_type,
      price_value: stage.price_value,
      price_currency: stage.price_currency,
      price_label: stage.price_label,
      price_confidence: stage.price_confidence,
      raw_source_path: stage.raw_source_path,
    }))
  const missingFields = [
    !sorted.length && 'stage_schedule',
    !selected?.price_label && 'mint_price',
    !selected?.start_time && status !== 'live_now' && status !== 'ended' && 'mint_start_time',
  ].filter(Boolean)
  const confidence = sorted.some(stage => stage.start_time && stage.price_label) ? 'high'
    : sorted.some(stage => stage.start_time || stage.price_label) ? 'medium'
      : 'low'
  const result = {
    stages: sorted,
    current_stage: current,
    next_stage: next,
    selected_stage: selected,
    status,
    mint_date: selected?.start_time || null,
    mint_end_date: selected?.end_time || null,
    mint_price: selected?.price_label || null,
    price_value: selected?.price_value ?? null,
    price_currency: selected?.price_currency || null,
    price_label: selected?.price_label || (missingFields.includes('mint_price') ? 'Price TBA' : null),
    price_note: selected?.price_note || (missingFields.includes('mint_price') ? 'OpenSea did not expose exact price.' : null),
    price_confidence: selected?.price_confidence || 'low',
    stage_prices: stagePrices,
    extracted_prices: stagePrices.map(item => item.price_label),
    rejected_price_candidates: rejectedPriceCandidates,
    extracted_times: sorted.filter(stage => stage.start_time || stage.end_time).map(stage => ({
      stage_name: stage.stage_name,
      start_time: stage.start_time,
      end_time: stage.end_time,
      timezone: stage.timezone,
      raw_source_path: stage.raw_source_path,
    })),
    missing_fields: missingFields,
    source_used: sorted.some(stage => stage.raw_source_path?.includes('html')) ? 'embedded_json_or_html' : sorted.length ? 'opensea_api_nested' : 'none',
    confidence,
    reason: missingFields.length ? missingFields.map(field => field === 'mint_price' ? 'OpenSea did not expose exact price' : field === 'mint_start_time' ? 'OpenSea did not expose exact start time' : 'Stage schedule unavailable').join('; ') : 'OpenSea schedule extracted.',
  }
  console.log('OpenSea generic schedule extraction', {
    url,
    slug,
    source_used: result.source_used,
    stages_found: result.stages.length,
    current_stage: result.current_stage?.stage_name || null,
    next_stage: result.next_stage?.stage_name || null,
    extracted_prices: result.extracted_prices,
    extracted_times: result.extracted_times,
    missing_fields: result.missing_fields,
    confidence: result.confidence,
    reason: result.reason,
  })
  return result
}

function stagePhase(stage = {}) {
  const text = `${stage.stage_type || ''} ${stage.name || ''} ${stage.kind || ''} ${stage.phase || ''}`.toLowerCase()
  if (text.includes('guaranteed') || text.includes('gtd')) return 'GTD'
  if ((text.includes('allow') || text.includes('white') || text.includes('wl')) && text.includes('fcfs')) return 'WL FCFS'
  if (text.includes('allow') || text.includes('white') || text.includes('presale') || text.includes('wl')) return 'Presale/WL'
  if (text.includes('open edition')) return 'Open Edition'
  if (text.includes('claim')) return 'Claim'
  if (text.includes('fcfs')) return 'FCFS'
  if (text.includes('public')) return 'Public'
  return 'Unknown'
}

function getStages(drop) {
  return [
    ...(Array.isArray(drop?.stages) ? drop.stages : []),
    ...(Array.isArray(drop?.mint_stages) ? drop.mint_stages : []),
    ...(Array.isArray(drop?.phases) ? drop.phases : []),
    ...(Array.isArray(drop?.collection?.mint_stages) ? drop.collection.mint_stages : []),
  ]
}

function stageTimes(stage) {
  return {
    start: parseDate(firstDefined(stage?.start_time, stage?.startTime, stage?.start_date, stage?.startDate, stage?.mint_start_time)),
    end: parseDate(firstDefined(stage?.end_time, stage?.endTime, stage?.end_date, stage?.endDate, stage?.mint_end_time)),
  }
}

function activeStage(drop) {
  const now = Date.now()
  const stages = getStages(drop)
    .map(stage => ({ stage, ...stageTimes(stage) }))
    .filter(item => item.start || item.end)
    .sort((a, b) => new Date(a.start || a.end).getTime() - new Date(b.start || b.end).getTime())
  return stages.find(item => {
    const start = item.start ? new Date(item.start).getTime() : -Infinity
    const end = item.end ? new Date(item.end).getTime() : Infinity
    return start <= now && end > now
  }) || stages.find(item => item.start && new Date(item.start).getTime() > now) || stages[0] || null
}

function dropStatus(drop, stageInfo) {
  const raw = `${drop?.status || ''} ${drop?.state || ''}`.toLowerCase()
  if (raw.includes('sold') || raw.includes('ended') || raw.includes('closed')) return 'ended'
  if (raw.includes('tba')) return 'tba'
  const start = parseDate(firstDefined(drop?.start_time, drop?.startTime, drop?.start_date, drop?.startDate)) || stageInfo?.start
  const end = parseDate(firstDefined(drop?.end_time, drop?.endTime, drop?.end_date, drop?.endDate)) || stageInfo?.end
  if (!start) return 'needs_review'
  const now = Date.now()
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : null
  if (endMs && endMs <= now) return 'ended'
  if (startMs > now) return 'upcoming'
  if (startMs <= now && (!endMs || endMs > now)) return 'live_now'
  return 'needs_review'
}

function dropPrice(drop, stage) {
  const value = firstDefined(
    stage?.price?.value,
    stage?.price,
    stage?.mint_price,
    stage?.mintPrice,
    drop?.mint_price,
    drop?.price
  )
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'object') {
    return firstDefined(value.quantity, value.amount, value.value, value.eth) || null
  }
  return String(value)
}

function collectionSlug(record) {
  return firstDefined(record?.collection_slug, record?.collection, record?.slug, record?.collection?.slug, record?.collection?.collection)
}

function collectionUrl(slug, fallback) {
  if (fallback) return fallback
  return slug ? `https://opensea.io/collection/${slug}` : null
}

function dropMintUrl(drop, slug) {
  return firstDefined(
    drop?.mint_url,
    drop?.mintUrl,
    drop?.drop_url,
    drop?.url,
    drop?.opensea_url,
    collectionUrl(slug)
  )
}

function missingFields({ contract, mintUrl, mintDate, mintType }) {
  return [
    !contract?.address && 'contract_address',
    !mintUrl && 'mint_url',
    !mintDate && 'mint_start_time',
    (!mintType || mintType === 'Unknown') && 'mint_phase',
  ].filter(Boolean)
}

export function normalizeOpenSeaDrop(drop) {
  const slug = collectionSlug(drop)
  const contract = primaryContract(drop)
  const mintUrl = dropMintUrl(drop, slug)
  const sourceUrl = collectionUrl(slug, drop?.opensea_url || drop?.collection?.opensea_url) || mintUrl
  const schedule = extractOpenSeaSchedule(drop, { url: sourceUrl, slug })
  const legacyStageInfo = activeStage(drop)
  const mintDate = schedule.mint_date || parseDate(firstDefined(drop?.start_time, drop?.startTime, drop?.start_date, drop?.startDate)) || legacyStageInfo?.start || null
  const mintEndDate = schedule.mint_end_date || parseDate(firstDefined(drop?.end_time, drop?.endTime, drop?.end_date, drop?.endDate)) || legacyStageInfo?.end || null
  const mintType = schedule.selected_stage?.access_type && schedule.selected_stage.access_type !== 'Unknown'
    ? schedule.selected_stage.access_type
    : legacyStageInfo ? stagePhase(legacyStageInfo.stage) : stagePhase(drop)
  const status = schedule.status !== 'needs_review' ? schedule.status : dropStatus(drop, legacyStageInfo)
  const name = cleanCollectionName(drop?.collection || drop) || cleanCollectionName(drop) || 'OpenSea Drop'
  const missing = missingFields({ contract, mintUrl, mintDate, mintType })
  const verified = missing.length === 0 && status !== 'needs_review'
  const chain = contract?.chain || drop?.chain || drop?.collection?.chain || 'eth'
  const scheduleMissing = Array.from(new Set([...(schedule.missing_fields || []), ...missing]))

  return normalizeProject({
    name,
    slug,
    image_url: firstDefined(drop?.image_url, drop?.image, drop?.collection?.image_url, drop?.collection?.banner_image_url),
    description: firstDefined(drop?.description, drop?.collection?.description, verified ? 'Verified OpenSea Drop.' : 'OpenSea drop needs review before minting.'),
    chain,
    contract_address: contract?.address || contract?.contract_address,
    mint_url: mintUrl,
    website_url: firstDefined(drop?.project_url, drop?.collection?.project_url, drop?.external_url),
    source_url: sourceUrl || mintUrl,
    mint_date: mintDate,
    mint_date_source: verified ? 'opensea_drops' : 'opensea_drops.partial',
    mint_date_confidence: verified ? 'high' : 'low',
    mint_time_confirmed: verified,
    mint_price: schedule.price_label || dropPrice(drop, legacyStageInfo?.stage),
    price_value: schedule.price_value,
    price_currency: schedule.price_currency,
    price_label: schedule.price_label,
    price_note: schedule.price_note,
    price_confidence: schedule.price_confidence,
    stage_prices: schedule.stage_prices,
    mint_schedule: schedule.stages,
    mint_type: mintType,
    status: status === 'live_now' ? 'live' : status === 'ended' ? 'ended' : verified ? 'approved' : 'pending_review',
    source_confidence: verified ? 'high' : 'low',
    hype_score: verified ? 70 : 20,
    hidden_gem_score: verified && status === 'upcoming' ? 35 : 10,
    risk_score: verified ? 35 : 58,
    mint_status: status,
    mint_end_date: mintEndDate,
    source_metadata: {
      provider: 'opensea_drops',
      schedule,
      stages: schedule.stages.length ? schedule.stages.slice(0, 8) : getStages(drop).slice(0, 5),
      stage_prices: schedule.stage_prices,
      current_stage: schedule.current_stage,
      next_stage: schedule.next_stage,
      selected_stage: schedule.selected_stage,
      missing_fields: scheduleMissing,
    },
  }, 'opensea_drops')
}

export async function fetchOpenSeaDropBySlug(slug) {
  if (!slug) return null
  try {
    const json = await openSeaJson(`/drops/collection/${encodeURIComponent(slug)}`)
    const drop = json.drop || json
    return normalizeOpenSeaDrop(drop)
  } catch {
    return null
  }
}

export async function fetchOpenSeaProjects({ limit = 12 } = {}) {
  const apiKey = process.env.OPENSEA_API_KEY
  if (!apiKey) return { projects: [], errors: ['OPENSEA_API_KEY missing'] }

  const projects = []
  const errors = []
  try {
    // Only fetch upcoming/featured — recently_minted are by definition past drops
    // and would fill the calendar with stale entries
    for (const type of ['upcoming', 'featured']) {
      try {
        const json = await openSeaJson('/drops', { searchParams: { type, limit: Math.min(limit, 30) } })
        const rows = json.drops || json.results || json.collections || []
        const now = Date.now()
        for (const row of rows) {
          const normalized = normalizeOpenSeaDrop(row)
          // Skip drops with a confirmed past mint date — they won't appear in any tab
          if (normalized.mint_date) {
            const mintMs = new Date(normalized.mint_date).getTime()
            // Allow up to 2h past (still "live" window), skip anything older
            if (mintMs < now - 2 * 60 * 60 * 1000) {
              errors.push(`drops:${type}:${normalized.name}: skipped (mint_date in past)`)
              continue
            }
          }
          projects.push(normalized)
          console.log('Alpha Radar source', {
            source: 'opensea_drops',
            name: normalized.name,
            mint_date: normalized.mint_date,
            confidence: normalized.source_confidence,
            missingFields: normalized.source_metadata?.missing_fields || [],
          })
        }
      } catch (error) {
        errors.push(`drops:${type}:${error.message}`)
      }
    }

    if (projects.length) return { projects, errors }

    const json = await openSeaJson('/collections', { searchParams: { limit: Math.min(limit, 30) } })
    const rows = json.collections || []
    const collectionProjects = rows
      .map((collection) => {
        const name = cleanCollectionName(collection)
        const contract = primaryContract(collection)
        const sourceUrl = collection.opensea_url || (collection.collection ? `https://opensea.io/collection/${collection.collection}` : null)
        if (!name || !contract?.address || !sourceUrl) return null

        const hasStrongMetadata = Boolean(collection.image_url && (collection.description || collection.project_url || sourceUrl))
        return normalizeProject({
          name,
          slug: collection.collection,
          image_url: collection.image_url,
          description: collection.description,
          chain: contract.chain || 'eth',
          contract_address: contract.address,
          mint_url: collection.project_url || collection.opensea_url,
          website_url: collection.project_url,
          source_url: sourceUrl,
          source_confidence: hasStrongMetadata ? 'medium' : 'low',
          status: hasStrongMetadata ? 'approved' : 'pending_review',
          hype_score: hasStrongMetadata ? 30 : 8,
        }, 'opensea')
      })
      .filter(Boolean)
    return { projects: collectionProjects, errors }
  } catch (error) {
    return { projects, errors: [...errors, error.message] }
  }
}
