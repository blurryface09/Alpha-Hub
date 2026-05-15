// api/metadata.js — Server-side project metadata extractor
// Supports: OpenSea (API + page scrape + countdown), Zora, Magic Eden,
//           Twitter/X, direct 0x contract address, plain alpha text, generic URLs

const OPENSEA_KEY = process.env.OPENSEA_API_KEY
const GROQ_KEY    = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY

const CHAIN_MAP = {
  ethereum: 'eth', eth: 'eth', mainnet: 'eth',
  base: 'base',
  bnb: 'bnb', bsc: 'bnb', binance: 'bnb',
  zora: 'eth', oeth: 'eth', optimism: 'eth', op: 'eth',
  polygon: 'eth', matic: 'eth',
  blast: 'eth', arbitrum: 'eth', arb: 'eth',
}

// ════════════════════════════════════════════════════════════════════════════
// STATUS CLASSIFICATION HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Maps a raw OpenSea API/page status string → canonical enum.
 * Returns: 'live_now' | 'upcoming' | 'ended' | 'tba' | null
 *
 * NOTE: 'minting' alone → null (ambiguous). We need 'minting_now' or
 * direct timestamp comparison for live_now.
 */
function classifyDropStatus(raw) {
  if (!raw) return null
  const s = String(raw).toLowerCase().replace(/[\s_-]+/g, '_')

  if (['live', 'active', 'open', 'live_now', 'minting_now',
       'minting_live', 'public_sale_live', 'sale_live'].includes(s)) return 'live_now'

  if (['upcoming', 'not_started', 'scheduled', 'pending',
       'minting_upcoming', 'countdown', 'coming_soon',
       'presale_pending', 'not_yet_started'].includes(s)) return 'upcoming'

  if (['ended', 'sold_out', 'soldout', 'closed', 'finished',
       'complete', 'completed', 'expired',
       'mint_ended', 'sale_ended'].includes(s)) return 'ended'

  if (['tba', 'to_be_announced', 'unscheduled'].includes(s)) return 'tba'

  return null
}

/**
 * Strict text-based status detection.
 * CRITICAL: countdown ("minting in") is checked BEFORE live ("minting now")
 * so "MINTING IN 8 HOURS" never becomes live_now.
 *
 * Returns: 'upcoming' | 'live_now' | 'ended' | 'tba' | null
 */
function detectTextStatus(text) {
  const t = String(text || '')

  // 1. Countdown keyword → upcoming (MUST be first)
  if (/minting\s+in\b|mint\s+starts?\s+in\b|sale\s+starts?\s+in\b|starts?\s+in\b/i.test(t))
    return 'upcoming'

  // 2. Explicit live patterns (word-boundary anchored)
  if (/\bminting\s+now\b|\bmint\s+now\b|\bmint\s+is\s+live\b|\bpublic\s+mint\s+live\b|\bsale\s+is\s+live\b|\bmint\s+open\b|\bminting\s+open\b|\blive\s+mint\b/i.test(t))
    return 'live_now'

  // 3. Ended / sold out
  if (/\bsold\s+out\b|\bmint\s+ended\b|\bsale\s+ended\b|\bfully\s+minted\b|\bminting\s+ended\b/i.test(t))
    return 'ended'

  // 4. TBA
  if (/\bcoming\s+soon\b|\bto\s+be\s+announced\b|\btba\b/i.test(t))
    return 'tba'

  return null
}

/**
 * Extracts countdown duration following a trigger keyword.
 * Handles: "MINTING IN 0 DAYS 8 HOURS 59 MINUTES [30 SECONDS]"
 * Returns: { totalMs, days, hours, minutes, seconds, text } or null
 */
function parseCountdown(text) {
  const t = String(text || '')

  // Find "minting in / mint starts in / ..." then capture what follows
  const ctxMatch = t.match(
    /(?:minting\s+in|mint\s+starts?\s+in|sale\s+starts?\s+in|starts?\s+in)\s+([\s\S]{0,100})/i
  )
  const segment = ctxMatch ? ctxMatch[1] : t

  const d = Number((segment.match(/(\d+)\s+days?/i)  || [])[1] || 0)
  const h = Number((segment.match(/(\d+)\s+hours?/i) || [])[1] || 0)
  const m = Number((segment.match(/(\d+)\s+min(?:utes?)?/i) || [])[1] || 0)
  const s = Number((segment.match(/(\d+)\s+sec(?:onds?)?/i) || [])[1] || 0)

  const totalMs = ((d * 86400) + (h * 3600) + (m * 60) + s) * 1000
  if (totalMs <= 0 && !(d === 0 && h === 0 && m === 0)) return null

  const parts = []
  if (d)              parts.push(`${d}d`)
  if (h)              parts.push(`${h}h`)
  if (m)              parts.push(`${m}m`)
  if (s && !d && !h)  parts.push(`${s}s`)

  return { totalMs, days: d, hours: h, minutes: m, seconds: s, text: parts.join(' ') || '< 1m' }
}

// ════════════════════════════════════════════════════════════════════════════
// PRICE HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a raw price value to an ETH/BNB decimal string.
 * Handles: normal floats, wei (≥ 1e15), integers, "0" (free).
 * Returns null for non-numeric or nonsensically large values.
 */
function normalizeEthPrice(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0)   return '0'                                // free mint
  if (n >= 1e15) return (n / 1e18).toFixed(6).replace(/\.?0+$/, '') // wei → ETH
  if (n > 1000)  return null                               // implausible ETH price
  return n.toString()
}

/**
 * Try every known price field on an OpenSea stage/drop object.
 * OpenSea v2 has used at least: mint_price, price, price_per_token,
 * native_price, sale_config.publicSalePrice, payment_token.eth_price.
 */
function extractStagePrice(stage, dropFallback = null) {
  if (!stage) return dropFallback
  const candidates = [
    stage.mint_price,
    stage.price,
    stage.price_per_token,
    stage.native_price,
    stage.sale_config?.publicSalePrice,
    stage.sale_config?.preSalePrice,
    stage.sale_config?.presalePrice,
    stage.payment_token?.eth_price,
  ]
  for (const raw of candidates) {
    const v = normalizeEthPrice(raw)
    if (v !== null) return v
  }
  return dropFallback
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE NAME HELPERS
// ════════════════════════════════════════════════════════════════════════════

/** DB wl_type: GTD | FCFS | PUBLIC | RAFFLE | UNKNOWN */
function stageToWlType(stage) {
  const s = String(stage || '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s.includes('gtd') || s.includes('guaranteed'))                     return 'GTD'
  if (s.includes('fcfs'))                                                 return 'FCFS'
  if (s.includes('raffle'))                                               return 'RAFFLE'
  if (s.includes('allow') || s.includes('whitelist') || s === 'wl' ||
      s.includes('private') || s.includes('presale'))                     return 'GTD'
  if (s.includes('public') || s.includes('open') || s.includes('claim')) return 'PUBLIC'
  return 'UNKNOWN'
}

/** Display mint_phase label */
function stageToMintPhase(stage) {
  const s = String(stage || '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s.includes('gtd') || s.includes('guaranteed'))                      return 'gtd'
  if (s.includes('allow') || s.includes('whitelist') || s === 'wl' ||
      s.includes('private') || s.includes('presale'))                     return 'wl'
  if (s.includes('public') && s.includes('fcfs'))                         return 'public_fcfs'
  if (s.includes('fcfs'))                                                  return 'wl_fcfs'
  if (s.includes('open_edition') ||
      (s.includes('open') && s.includes('edition')))                      return 'open_edition'
  if (s.includes('claim'))                                                 return 'claim'
  if (s.includes('public'))                                                return 'public'
  return 'unknown'
}

/** Human-readable stage label (no snake_case, no "Stage 1") */
function stageDisplayName(raw) {
  if (!raw) return null
  const s = String(raw).toLowerCase().trim()
  const MAP = {
    public: 'Public', allowlist: 'Allowlist', allow_list: 'Allowlist',
    whitelist: 'Whitelist', presale: 'Presale', fcfs: 'FCFS',
    gtd: 'GTD', guaranteed: 'GTD',
    open_edition: 'Open Edition', openedition: 'Open Edition',
    claim: 'Claim', raffle: 'Raffle',
  }
  if (MAP[s]) return MAP[s]
  // Title-case anything else rather than showing raw snake_case
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ════════════════════════════════════════════════════════════════════════════
// HTML UTILITIES
// ════════════════════════════════════════════════════════════════════════════

function decodeHtml(str) {
  return String(str || '')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function extractNextData(html) {
  const m = String(html || '').match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  )
  if (!m) return null
  try { return JSON.parse(decodeHtml(m[1])) } catch { return null }
}

// ════════════════════════════════════════════════════════════════════════════
// OPENSEA API — COLLECTION METADATA ONLY
// ════════════════════════════════════════════════════════════════════════════

async function fetchOpenSea(slug) {
  if (!OPENSEA_KEY) return null
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
      { headers: { 'X-API-KEY': OPENSEA_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(6000) }
    )
    if (!r.ok) return null
    const d = await r.json()
    const contract = d.contracts?.[0]
    return {
      name:             d.name              || null,
      description:      d.description       || null,
      image_url:        d.image_url          || null,
      chain:            CHAIN_MAP[contract?.chain?.toLowerCase()] || 'eth',
      contract_address: contract?.address    || null,
      total_supply:     d.total_supply        || null,
      twitter_handle:   d.twitter_username ? `@${d.twitter_username}` : null,
      discord_url:      d.discord_url         || null,
    }
  } catch (e) {
    console.warn('[opensea-collection] failed:', e.message)
    return null
  }
}

// ════════════════════════════════════════════════════════════════════════════
// OPENSEA STAGE NORMALIZER — source of truth
// ════════════════════════════════════════════════════════════════════════════

/** True if obj has enough fields to be treated as a mint stage */
function looksLikeStage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  return !!(
    obj.start_date        || obj.start_time        ||
    obj.end_date          || obj.end_time           ||
    obj.mint_price != null || obj.price != null      ||
    obj.price_per_token != null                      ||
    obj.allowlist_type    || obj.sale_type           ||
    (typeof obj.stage === 'string' && obj.stage.length < 60) ||
    obj.stage_name
  )
}

/**
 * Flatten a drops-API `drops[]` array into raw stage-like objects.
 * Nested stages[] inherit their parent drop's timing/price as fallbacks.
 */
function harvestFromDropsApi(drops) {
  const raw = []
  for (const drop of (drops || [])) {
    const dropStart = drop.start_date || drop.start_time || null
    const dropEnd   = drop.end_date   || drop.end_time   || null
    const nested    = Array.isArray(drop.stages) && drop.stages.length ? drop.stages : null
    if (nested) {
      for (const s of nested) {
        raw.push({
          ...s,
          // inherit drop-level time if stage doesn't have its own
          start_date:     s.start_date || s.start_time || dropStart,
          end_date:       s.end_date   || s.end_time   || dropEnd,
          _drop_price:    drop.mint_price ?? drop.price ?? null,
          _drop_max:      drop.max_per_wallet ?? null,
        })
      }
    } else {
      raw.push(drop)
    }
  }
  return raw
}

/**
 * Recursively harvest stage-like objects from any JSON blob.
 * Walks known container keys; collects arrays that look like stage lists.
 */
function harvestFromJson(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return []
  const results = []

  if (Array.isArray(node)) {
    const stageLike = node.filter(looksLikeStage)
    // If most items in the array look like stages, collect them all
    if (stageLike.length && stageLike.length >= Math.ceil(node.length / 2)) {
      return stageLike
    }
    for (const item of node) results.push(...harvestFromJson(item, depth + 1))
    return results
  }

  // Keys known to contain stage arrays
  for (const key of ['stages', 'sale_stages', 'mint_stages', 'saleStages', 'phases',
                      'mintSchedule', 'schedule', 'drops', 'mintStages']) {
    if (node[key]) results.push(...harvestFromJson(node[key], depth + 1))
  }

  // Single-object stage (e.g. a lone drop at depth > 1)
  if (depth > 1 && looksLikeStage(node) && results.length === 0) {
    results.push(node)
  }

  // Recurse into wrapper objects
  for (const key of ['drop', 'collection', 'initialData', 'pageProps', 'props',
                      'data', 'event', 'nft', 'launchpad', 'mintInfo']) {
    if (node[key] && typeof node[key] === 'object') {
      results.push(...harvestFromJson(node[key], depth + 1))
    }
  }

  return results
}

/**
 * THE source of truth for all OpenSea stage data.
 *
 * Input:  rawList — any array of stage-like objects from any source
 * Output: normalized, deduplicated, time-sorted stage array
 *
 * Each stage: { name, raw_name, start_time, end_time, price, token,
 *               max_per_wallet, eligibility, wl_type, status }
 *
 * Status is computed from timestamps first; API status field is only a fallback.
 * Text-based detection is NOT used here — it happens upstream only if stages = [].
 */
function normalizeOpenSeaStages(rawList, token = 'ETH') {
  if (!rawList?.length) return []
  const now  = Date.now()
  const seen = new Set()
  const out  = []

  for (const s of rawList) {
    if (!s || typeof s !== 'object') continue

    const rawName   = s.stage || s.stage_name || s.name || s.phase || null
    const startRaw  = s.start_date  || s.start_time  || s.startDate  || null
    const endRaw    = s.end_date    || s.end_time    || s.endDate    || null
    // Try all known price fields; then fall back to inherited drop price
    const price     = extractStagePrice(s) ??
                      (s._drop_price != null ? normalizeEthPrice(s._drop_price) : null)
    const maxWallet = s.max_per_wallet ?? s._drop_max ?? null
    const allowRaw  = s.allowlist_type || s.sale_type || null

    // Deduplicate by (start, end, price, name)
    const fp = `${startRaw}|${endRaw}|${price}|${rawName}`
    if (seen.has(fp)) continue
    seen.add(fp)

    // Compute status from timestamp window — never from page text
    let status = 'unknown'
    if (startRaw) {
      const start = new Date(startRaw).getTime()
      if (!Number.isNaN(start)) {
        const end = endRaw ? new Date(endRaw).getTime() : Infinity
        if      (start <= now && now < end) status = 'live_now'
        else if (end   <= now)             status = 'ended'
        else                               status = 'upcoming'
      }
    }
    // Only use API status field when there are no timestamps
    if (status === 'unknown') {
      status = classifyDropStatus(s.status || s.stage_status || s.mint_status) || 'unknown'
    }

    out.push({
      name:           stageDisplayName(rawName),
      raw_name:       rawName,
      start_time:     startRaw,
      end_time:       endRaw,
      price,
      token,
      max_per_wallet: maxWallet != null ? (Number(maxWallet) || null) : null,
      eligibility:    allowRaw,
      wl_type:        stageToWlType(rawName || allowRaw || ''),
      status,
    })
  }

  // Sort: live → upcoming (by start_time) → ended → unknown
  const ORDER = { live_now: 0, upcoming: 1, ended: 2, unknown: 3 }
  return out.sort((a, b) => {
    const od = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
    if (od !== 0) return od
    if (!a.start_time && !b.start_time) return 0
    if (!a.start_time) return 1
    if (!b.start_time) return -1
    return new Date(a.start_time) - new Date(b.start_time)
  })
}

/**
 * Unified OpenSea resolver — replaces fetchOpenSeaDrops + scrapeOpenSeaPage.
 *
 * Sources (all attempted, not sequential fallbacks):
 *   1. OpenSea drops API  (requires OPENSEA_API_KEY)
 *   2. Page __NEXT_DATA__ (always — no key required)
 *
 * normalizeOpenSeaStages() is the sole consumer of all raw data.
 * Text-based detection is ONLY used when zero structured stages are found.
 *
 * Returns:
 *   { stages, current_stage, next_stage, mint_status, mint_date, end_date,
 *     mint_price, stage_name, max_per_wallet, has_wl_phase, countdown_text,
 *     debug_opensea_extraction }
 */
async function resolveOpenSeaStages(slug, pageUrl, token = 'ETH') {
  const debug = {
    source_used:      [],
    stages_found:     0,
    raw_stage_keys:   [],
    price_candidates: [],
    time_candidates:  [],
    selected_stage:   null,
    failure_reason:   null,
  }

  const rawStages = []
  let   pageText  = ''

  // ── 1. Drops API (if key present) ────────────────────────────────────────
  if (OPENSEA_KEY) {
    try {
      const r = await fetch(
        `https://api.opensea.io/api/v2/drops?collection_slug=${encodeURIComponent(slug)}&limit=20`,
        { headers: { 'X-API-KEY': OPENSEA_KEY, accept: 'application/json' },
          signal: AbortSignal.timeout(6000) }
      )
      if (r.ok) {
        const d    = await r.json()
        const from = harvestFromDropsApi(Array.isArray(d.drops) ? d.drops : [])
        if (from.length) {
          rawStages.push(...from)
          debug.source_used.push('drops_api')
        } else {
          console.log('[opensea-drops] empty drops for slug:', slug)
        }
      } else {
        console.warn('[opensea-drops] non-ok', r.status, 'slug:', slug)
      }
    } catch (e) { console.warn('[opensea-drops]', e.message) }
  }

  // ── 2. Page HTML → __NEXT_DATA__ (always, not just as fallback) ──────────
  try {
    const r = await fetch(pageUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (r.ok) {
      const html = await r.text()

      // Strip HTML for text fallback
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 100_000)

      // Extract __NEXT_DATA__ and recursively harvest stages from it
      const nextData = extractNextData(html)
      if (nextData) {
        const from = harvestFromJson(nextData)
        if (from.length) {
          rawStages.push(...from)
          debug.source_used.push('__next_data__')
        } else {
          debug.source_used.push('__next_data__:no_stages')
        }
      } else {
        debug.source_used.push('page:no_next_data')
      }
    }
  } catch (e) { console.warn('[opensea-page]', e.message) }

  // ── 3. Normalize all raw stages via source of truth ──────────────────────
  const stages = normalizeOpenSeaStages(rawStages, token)

  debug.stages_found     = stages.length
  debug.raw_stage_keys   = [...new Set(rawStages.flatMap(s =>
    Object.keys(s).filter(k => !k.startsWith('_'))))]
  debug.price_candidates = rawStages.map(s => extractStagePrice(s)).filter(v => v !== null)
  debug.time_candidates  = rawStages
    .map(s => s.start_date || s.start_time).filter(Boolean).slice(0, 10)

  // ── 4. No structured stages → text-based fallback (last resort only) ─────
  if (!stages.length) {
    debug.failure_reason  = 'no_structured_stages'
    debug.source_used.push('text_fallback')

    if (pageText) {
      const textStatus = detectTextStatus(pageText)

      if (textStatus === 'upcoming') {
        const countdown   = parseCountdown(pageText)
        const approxStart = countdown?.totalMs > 30_000
          ? new Date(Date.now() + countdown.totalMs).toISOString()
          : null
        debug.selected_stage = { source: 'text_countdown', countdown: countdown?.text }
        return {
          stages: [], mint_status: 'upcoming',
          mint_date: approxStart, countdown_text: countdown?.text || null,
          has_wl_phase: false, debug_opensea_extraction: debug,
        }
      }

      if (textStatus === 'live_now') {
        debug.selected_stage = { source: 'text_live_now' }
        return {
          stages: [], mint_status: 'live_now', has_wl_phase: false,
          debug_opensea_extraction: debug,
        }
      }

      if (textStatus) {
        debug.selected_stage = { source: `text_${textStatus}` }
        return {
          stages: [], mint_status: textStatus, has_wl_phase: false,
          debug_opensea_extraction: debug,
        }
      }
    }

    debug.failure_reason = 'no_signal_found'
    return { stages: [], mint_status: null, has_wl_phase: false,
             debug_opensea_extraction: debug }
  }

  // ── 5. Compute top-level fields from normalized stages ────────────────────
  const now      = Date.now()
  const liveSt   = stages.filter(s => s.status === 'live_now')
  const upcomSt  = stages.filter(s => s.status === 'upcoming')
  const endedSt  = stages.filter(s => s.status === 'ended')

  const current  = liveSt[0]  || null
  const next     = upcomSt[0] || null
  const primary  = current || next || stages[0]

  const mintStatus =
    current                             ? 'live_now'
    : next                              ? 'upcoming'
    : endedSt.length === stages.length  ? 'ended'
    : null

  const hasWl = stages.some(s => ['GTD', 'FCFS', 'RAFFLE'].includes(s.wl_type))

  // Countdown from actual next_stage start_time (accurate, not parsed from text)
  let countdownText = null
  if (next?.start_time) {
    const ms = new Date(next.start_time).getTime() - now
    if (ms > 0 && ms < 30 * 24 * 3600 * 1000) {
      const d = Math.floor(ms / 86400000)
      const h = Math.floor((ms % 86400000) / 3600000)
      const m = Math.floor((ms % 3600000) / 60000)
      const parts = []
      if (d) parts.push(`${d}d`)
      if (h) parts.push(`${h}h`)
      if (m && !d) parts.push(`${m}m`)
      countdownText = parts.join(' ') || '< 1m'
    }
  }

  debug.selected_stage = primary
    ? { name: primary.name, status: primary.status, price: primary.price }
    : null

  console.log('[opensea-stages] slug=%s status=%s stage=%s price=%s stages=%d sources=%s',
    slug, mintStatus || 'none', primary?.name || 'n/a',
    primary?.price || 'n/a', stages.length, debug.source_used.join('+'))

  return {
    stages:          stages.map(s => ({
      name:           s.name,
      start_time:     s.start_time,
      end_time:       s.end_time,
      price:          s.price,
      token:          s.token,
      wl_type:        s.wl_type,
      max_per_wallet: s.max_per_wallet,
      status:         s.status,
    })),
    current_stage:   current?.name  || null,
    next_stage:      next?.name     || null,
    mint_status:     mintStatus,
    mint_date:       primary?.start_time || null,
    end_date:        primary?.end_time   || null,
    mint_price:      primary?.price      || null,
    stage_name:      primary?.raw_name   || null,
    max_per_wallet:  primary?.max_per_wallet || null,
    has_wl_phase:    hasWl,
    countdown_text:  countdownText,
    debug_opensea_extraction: debug,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GROQ AI FALLBACK
// ════════════════════════════════════════════════════════════════════════════

async function callGroq(prompt, maxTokens = 256) {
  if (!GROQ_KEY) return null
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  maxTokens,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const d    = await r.json()
    const text = d.choices?.[0]?.message?.content || ''
    const m    = text.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[0])
  } catch {}
  return null
}

// ════════════════════════════════════════════════════════════════════════════
// CONTRACT / TEXT DETECTORS
// ════════════════════════════════════════════════════════════════════════════

async function detectContractInput(address) {
  const ai = await callGroq(
    `NFT or crypto project contract address: ${address}\n` +
    `Return ONLY valid JSON:\n{"name":null,"chain":"eth"|"base"|"bnb"|null,"notes":null}`,
    128
  )
  return {
    name:             ai?.name  || null,
    source_type:      'contract',
    chain:            ai?.chain || 'eth',
    contract_address: address,
    notes:            ai?.notes || `Contract: ${address}`,
    confidence: {
      name:             ai?.name  ? 'ai_inferred' : 'missing',
      chain:            ai?.chain ? 'ai_inferred' : 'missing',
      contract_address: 'url_extracted',
      mint_date:        'missing',
      mint_price:       'missing',
    },
    missing_fields: [
      ...(!ai?.name  ? ['name']  : []),
      ...(!ai?.chain ? ['chain'] : []),
      'mint_date', 'mint_price',
    ],
  }
}

async function detectPlainText(text) {
  const urlContract = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0] || null
  const ai = await callGroq(
    `Extract NFT/crypto mint details from this alpha text:\n"${text.slice(0, 600)}"\n\n` +
    `Return ONLY valid JSON (null for unknown):\n` +
    `{"name":null,"chain":null,"contract_address":null,"mint_date":null,"mint_price":null,"wl_phase":"unknown","notes":null}`,
    300
  )
  const hasContract = ai?.contract_address || urlContract
  return {
    name:             ai?.name             || null,
    source_type:      'text',
    chain:            ai?.chain            || 'eth',
    contract_address: ai?.contract_address || urlContract,
    mint_date:        ai?.mint_date        || null,
    mint_price:       ai?.mint_price       || null,
    mint_phase:       ai?.wl_phase         || 'unknown',
    wl_type:          stageToWlType(ai?.wl_phase),
    notes:            ai?.notes            || null,
    confidence: {
      name:             ai?.name         ? 'ai_inferred' : 'missing',
      chain:            ai?.chain        ? 'ai_inferred' : 'missing',
      contract_address: hasContract      ? 'ai_inferred' : 'missing',
      mint_date:        ai?.mint_date    ? 'ai_inferred' : 'missing',
      mint_price:       ai?.mint_price   ? 'ai_inferred' : 'missing',
    },
    missing_fields: [
      ...(!ai?.name         ? ['name']             : []),
      ...(!ai?.chain        ? ['chain']            : []),
      ...(!hasContract      ? ['contract_address'] : []),
      ...(!ai?.mint_date    ? ['mint_date']        : []),
      ...(!ai?.mint_price   ? ['mint_price']       : []),
    ],
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN EXTRACTOR
// ════════════════════════════════════════════════════════════════════════════

async function extractMetadata(rawInput) {
  const input = rawInput.trim()

  if (/^0x[a-fA-F0-9]{40}$/i.test(input)) return detectContractInput(input)

  const looksLikeUrl = /^https?:\/\//i.test(input) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(input)
  if (!looksLikeUrl && input.length > 5) return detectPlainText(input)

  let url = input
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url

  let parsed
  try { parsed = new URL(url) } catch { return fail('Invalid URL') }

  const host        = parsed.hostname.replace(/^www\./, '').toLowerCase()
  const path        = parsed.pathname
  const urlContract = (url.match(/0x[a-fA-F0-9]{40}/) || [])[0] || null

  // ── OpenSea ────────────────────────────────────────────────────────────────
  if (host === 'opensea.io') {
    const m = path.match(/\/collection\/([^/?#]+)/)
    if (m) {
      const slug = m[1]

      // Fetch collection metadata + resolve all stages in parallel.
      // resolveOpenSeaStages() is the sole source of truth for timing/price/status.
      // It hits drops API (if key) AND __NEXT_DATA__ always.
      const [api, stageResult] = await Promise.all([
        fetchOpenSea(slug),
        resolveOpenSeaStages(slug, url, 'ETH'),   // token corrected below after chain is known
      ])

      const chain = api?.chain || 'eth'
      const token = chain === 'bnb' ? 'BNB' : 'ETH'

      // Re-stamp stages with correct token now that we know the chain
      const stages = (stageResult.stages || []).map(s => ({ ...s, token }))

      const mintStatus    = stageResult.mint_status    || null
      const mintDate      = stageResult.mint_date      || null
      const endDate       = stageResult.end_date       || null
      const mintPrice     = stageResult.mint_price     || null
      const stageName     = stageResult.stage_name     || null
      const countdownText = stageResult.countdown_text || null

      const isLiveNow   = mintStatus === 'live_now'
      const hasContract = Boolean(api?.contract_address || urlContract)
      const hasDate     = Boolean(mintDate)
      // "has price" = top-level mint_price OR any stage with a price
      const hasPrice    = Boolean(mintPrice) || stages.some(s => s.price != null)
      const priceNote   = !hasPrice ? 'Price not exposed by OpenSea' : null

      console.log('[opensea-resolver]', JSON.stringify({
        slug, chain, token,
        status:   mintStatus || 'none',
        stages:   stages.length,
        price:    mintPrice || 'none',
        sources:  stageResult.debug_opensea_extraction?.source_used || [],
        selected: stageResult.debug_opensea_extraction?.selected_stage || null,
      }))

      if (api) {
        return {
          name:             api.name,
          source_type:      'opensea',
          chain,
          contract_address: api.contract_address || urlContract,
          total_supply:     api.total_supply,
          image_url:        api.image_url,
          twitter_handle:   api.twitter_handle,
          discord_url:      api.discord_url,
          mint_status:      mintStatus,
          mint_date:        mintDate,
          end_date:         endDate,
          mint_price:       mintPrice,
          price_note:       priceNote,
          countdown_text:   countdownText,
          mint_phase:       stageName ? stageToMintPhase(stageName) : null,
          wl_type:          stageName ? stageToWlType(stageName)    : 'UNKNOWN',
          max_per_wallet:   stageResult.max_per_wallet  || null,
          stages,
          has_wl_phase:     stageResult.has_wl_phase    || false,
          current_stage:    stageResult.current_stage   || null,
          next_stage:       stageResult.next_stage      || null,
          notes:            api.description?.slice(0, 120) || `OpenSea: ${slug}`,
          confidence: {
            name:             'api_verified',
            chain:            'api_verified',
            contract_address: api.contract_address ? 'api_verified'
                            : urlContract          ? 'url_extracted' : 'missing',
            mint_date:        hasDate       ? 'api_verified'
                            : isLiveNow     ? 'api_verified'
                            : countdownText ? 'low' : 'missing',
            mint_price:       hasPrice      ? 'api_verified' : 'missing',
          },
          missing_fields: [
            ...(!hasDate && !isLiveNow ? ['mint_date']       : []),
            ...(!hasPrice              ? ['mint_price']       : []),
            ...(!hasContract           ? ['contract_address'] : []),
          ],
          debug_opensea_extraction: stageResult.debug_opensea_extraction,
        }
      }

      // No collection API key — use stage result + slug-derived name
      const slugName = slug.split('-').map(w => (w[0] || '').toUpperCase() + w.slice(1)).join(' ')

      if (mintStatus || mintDate || stages.length) {
        return {
          name:             slugName,
          source_type:      'opensea',
          chain:            'eth',
          contract_address: urlContract,
          mint_status:      mintStatus,
          mint_date:        mintDate,
          end_date:         endDate,
          mint_price:       mintPrice,
          price_note:       priceNote,
          countdown_text:   countdownText,
          stages,
          has_wl_phase:     stageResult.has_wl_phase  || false,
          current_stage:    stageResult.current_stage || null,
          next_stage:       stageResult.next_stage    || null,
          notes:            `OpenSea collection: ${slug}`,
          confidence: {
            name:             'url_extracted',
            chain:            'url_extracted',
            contract_address: urlContract ? 'url_extracted' : 'missing',
            mint_date:        mintDate    ? 'low' : mintStatus ? 'page_detected' : 'missing',
            mint_price:       hasPrice    ? 'low' : 'missing',
          },
          missing_fields: [
            ...(!mintDate && !mintStatus ? ['mint_date']       : []),
            ...(!hasPrice                ? ['mint_price']       : []),
            ...(!urlContract             ? ['contract_address'] : []),
          ],
          debug_opensea_extraction: stageResult.debug_opensea_extraction,
        }
      }

      // Pure slug fallback (no data at all)
      return {
        name:             slugName,
        source_type:      'opensea',
        chain:            'eth',
        contract_address: urlContract,
        price_note:       'Price not exposed by OpenSea',
        notes:            `OpenSea collection: ${slug}`,
        confidence: {
          name: 'url_extracted', chain: 'url_extracted',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date: 'missing', mint_price: 'missing',
        },
        missing_fields: ['mint_date', 'mint_price', ...(!urlContract ? ['contract_address'] : [])],
        debug_opensea_extraction: stageResult.debug_opensea_extraction,
      }
    }
  }

  // ── Zora ──────────────────────────────────────────────────────────────────
  if (host.includes('zora.co')) {
    const m = path.match(/\/collect\/([^:/?#]+)(?::([^/?#]+))?/)
    if (m) {
      const chainSlug  = m[1].toLowerCase()
      const addrInPath = (m[2] || '').match(/0x[a-fA-F0-9]{40}/)?.[0] || urlContract
      const chain      = CHAIN_MAP[chainSlug] || 'eth'
      const ai = await callGroq(
        `NFT project Zora URL: ${url}\nReturn ONLY valid JSON: {"name":null,"notes":null}`, 128
      )
      return {
        name:             ai?.name    || null,
        source_type:      'zora',
        chain,
        contract_address: addrInPath,
        notes:            ai?.notes   || `Zora collection on ${chainSlug}`,
        confidence: {
          name:             ai?.name ? 'ai_inferred' : 'missing',
          chain:            'url_extracted',
          contract_address: addrInPath ? 'url_extracted' : 'missing',
          mint_date:        'missing', mint_price: 'missing',
        },
        missing_fields: [
          ...(!ai?.name   ? ['name']             : []),
          'mint_date', 'mint_price',
          ...(!addrInPath ? ['contract_address'] : []),
        ],
      }
    }
  }

  // ── Magic Eden ────────────────────────────────────────────────────────────
  if (host.includes('magiceden.io') || host.includes('magiceden.dev')) {
    const m = path.match(/\/collections?\/([^/?#]+)\/([^/?#]+)/)
    if (m) {
      const chainSlug = m[1].toLowerCase()
      const slug      = m[2]
      const chain     = CHAIN_MAP[chainSlug]
      const name      = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      if (!chain) {
        return {
          name, source_type: 'magiceden', chain: null, contract_address: null,
          notes:   `Magic Eden (${chainSlug}) — EVM auto-mint not supported`,
          warning: `${chainSlug} chain is not supported for auto-mint. You can still track manually.`,
          confidence: { name: 'url_extracted', chain: 'missing', contract_address: 'missing', mint_date: 'missing', mint_price: 'missing' },
          missing_fields: ['chain', 'contract_address', 'mint_date', 'mint_price'],
        }
      }
      return {
        name, source_type: 'magiceden', chain, contract_address: urlContract,
        notes: `Magic Eden: ${chainSlug} collection`,
        confidence: {
          name: 'url_extracted', chain: 'url_extracted',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date: 'missing', mint_price: 'missing',
        },
        missing_fields: ['mint_date', 'mint_price', ...(!urlContract ? ['contract_address'] : [])],
      }
    }
  }

  // ── Twitter / X ───────────────────────────────────────────────────────────
  if (host === 'twitter.com' || host === 'x.com') {
    const skip = new Set(['i','home','explore','notifications','messages','search','compose','settings','intent'])
    const m = path.match(/^\/([^/?#]+)/)
    if (m && !skip.has(m[1].toLowerCase())) {
      const handle = m[1]
      return {
        name: handle, source_type: 'twitter', chain: 'eth',
        contract_address: urlContract, twitter_handle: `@${handle}`,
        notes: `Twitter: @${handle}`,
        confidence: {
          name: 'url_extracted', chain: 'missing',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date: 'missing', mint_price: 'missing',
        },
        missing_fields: ['mint_date', 'mint_price', ...(!urlContract ? ['contract_address'] : [])],
      }
    }
  }

  // ── Generic / Groq fallback ───────────────────────────────────────────────
  const ai = await callGroq(
    `Extract NFT/crypto project metadata from this URL: ${url}\n\n` +
    `Return ONLY valid JSON (null for unknown):\n` +
    `{"name":null,"chain":null,"contract_address":null,"mint_price":null,"notes":null}`
  )
  if (ai?.name) {
    const hasContract = ai.contract_address || urlContract
    return {
      name: ai.name, source_type: 'website', chain: ai.chain || 'eth',
      contract_address: ai.contract_address || urlContract,
      mint_price: ai.mint_price || null, notes: ai.notes || null,
      confidence: {
        name: 'ai_inferred',
        chain:            ai.chain         ? 'ai_inferred' : 'missing',
        contract_address: hasContract      ? (ai.contract_address ? 'ai_inferred' : 'url_extracted') : 'missing',
        mint_date:        'missing',
        mint_price:       ai.mint_price    ? 'ai_inferred' : 'missing',
      },
      missing_fields: [
        ...(!ai.chain      ? ['chain']            : []),
        ...(!hasContract   ? ['contract_address'] : []),
        'mint_date',
        ...(!ai.mint_price ? ['mint_price']       : []),
      ],
    }
  }

  // Last resort: URL slug
  const parts    = path.split('/').filter(Boolean)
  const namePart = parts[parts.length - 1] || host.split('.')[0]
  const fallback = namePart.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return {
    name: fallback || null, source_type: 'website', chain: 'eth', contract_address: urlContract,
    confidence: {
      name:             fallback    ? 'url_extracted' : 'missing',
      chain:            'missing',
      contract_address: urlContract ? 'url_extracted' : 'missing',
      mint_date:        'missing', mint_price: 'missing',
    },
    missing_fields: [
      ...(!fallback    ? ['name']             : []),
      'mint_date', 'mint_price',
      ...(!urlContract ? ['contract_address'] : []),
    ],
  }
}

function fail(msg) {
  return {
    name: null, source_type: 'website', chain: 'eth', contract_address: null, error: msg,
    confidence: { name: 'missing', chain: 'missing', contract_address: 'missing', mint_date: 'missing', mint_price: 'missing' },
    missing_fields: ['name', 'chain', 'contract_address', 'mint_date', 'mint_price'],
  }
}

// ════════════════════════════════════════════════════════════════════════════
// VERCEL HANDLER
// ════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'url param required' })

  try {
    const result = await extractMetadata(decodeURIComponent(url))
    return res.status(200).json(result)
  } catch (e) {
    console.error('[metadata]', e.message)
    return res.status(200).json(fail(e.message))
  }
}
