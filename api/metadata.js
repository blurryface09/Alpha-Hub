// api/metadata.js — Server-side project metadata extractor
// Supports: OpenSea (API + page scrape + countdown), Zora, Magic Eden,
//           Twitter/X, direct 0x contract address, plain alpha text, generic URLs

const OPENSEA_KEY             = process.env.OPENSEA_API_KEY
const GROQ_KEY                = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY
const RENDER_EXTRACTOR_URL    = process.env.RENDER_EXTRACTOR_URL    || ''
const RENDER_EXTRACTOR_SECRET = process.env.RENDER_EXTRACTOR_SECRET || ''

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
 * Extract price from a stage/drop object.
 * Delegates to extractAllPrices() — defined below — after the stage normalizer section.
 * This wrapper exists so callers before the normalizer section can still call it.
 * NOTE: extractAllPrices() is defined in the normalizer section; JS hoisting handles it.
 */
function extractStagePrice(stage, dropFallback = null) {
  if (!stage) return dropFallback ?? null
  // extractAllPrices is defined later in the file; call it directly
  const v = extractAllPrices(stage)
  return v !== null ? v : (dropFallback ?? null)
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
// OPENSEA STAGE NORMALIZER — generic, project-agnostic source of truth
// ════════════════════════════════════════════════════════════════════════════

// Recognized stage names per OpenSea and common NFT drop conventions
const RECOGNIZED_STAGE_NAMES = new Set([
  'public', 'allowlist', 'allow_list', 'whitelist', 'presale', 'pre_sale',
  'fcfs', 'gtd', 'guaranteed', 'team_treasury', 'team', 'treasury', 'claim',
  'open_edition', 'openedition', 'holder_mint', 'holdermint', 'wl', 'raffle',
  'private', 'community', 'og', 'vip', 'early_access', 'public_sale',
  'allowlist_sale', 'partner', 'waitlist',
])

// Keys that mark an object as collection/drop metadata rather than a stage.
// Objects dominated by these keys with no stage-specific data must be rejected.
const COLLECTION_META_KEYS = new Set([
  'collection_slug', 'collection_name', 'image_url', 'banner_image_url',
  'total_supply', 'twitter_username', 'discord_url', 'description',
  'created_date', 'opensea_url', 'category', 'is_minting', 'drop_type',
  'chain', 'contract_address', 'contract',
])

/**
 * Extended price extraction — tries every known OpenSea price variant.
 * Handles nested sale_config, payment_token, display_price, wei values.
 */
function extractAllPrices(obj) {
  if (!obj || typeof obj !== 'object') return null
  const candidates = [
    obj.mint_price,
    obj.price,
    obj.price_per_token,
    obj.native_price,
    obj.display_price,
    obj.price_in_eth,
    obj.sale_config?.publicSalePrice,
    obj.sale_config?.preSalePrice,
    obj.sale_config?.presalePrice,
    obj.sale_config?.price,
    obj.sale_config?.mintPrice,
    obj.payment_token?.eth_price,
    obj.payment_token?.usd_price,  // skip: not ETH
    obj.price_details?.price,
    obj.price_details?.amount,
  ]
  // Only numeric candidates; skip usd_price which would be a large number in USD
  const ethCandidates = candidates.filter((_, i) => i !== 13) // skip usd_price index
  for (const raw of ethCandidates) {
    const v = normalizeEthPrice(raw)
    if (v !== null) return v
  }
  // Also try sale_config children recursively (one level)
  if (obj.sale_config && typeof obj.sale_config === 'object') {
    for (const v of Object.values(obj.sale_config)) {
      const n = normalizeEthPrice(v)
      if (n !== null) return n
    }
  }
  return null
}

/**
 * Strict stage candidate validator.
 *
 * A raw object is a REAL stage if it has at least one strong signal:
 *   - price (any field variant)
 *   - start_time / end_time
 *   - max_per_wallet
 *   - allowlist_type / sale_type / eligibility
 *   - recognized stage name
 *
 * Objects that are purely collection metadata (dominated by COLLECTION_META_KEYS
 * with zero stage-specific signals) are rejected and never become stages.
 *
 * Returns: null (rejected) | reason string for logging
 */
function validateStageCandidate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  // Count how many collection metadata markers this object has
  const keys = Object.keys(obj)
  const metaCount  = keys.filter(k => COLLECTION_META_KEYS.has(k)).length

  const hasPrice       = extractAllPrices(obj) !== null
  const hasTime        = !!(obj.start_date || obj.start_time || obj.end_date || obj.end_time)
  const hasWalletLimit = obj.max_per_wallet != null
  const hasEligibility = !!(obj.allowlist_type || obj.sale_type || obj.eligibility)
  const rawStageName   = String(obj.stage || obj.stage_name || obj.name || obj.phase || '').toLowerCase().trim()
  const hasKnownName   = rawStageName.length > 0 &&
    [...RECOGNIZED_STAGE_NAMES].some(n => rawStageName.includes(n))

  const strongSignals = [hasPrice, hasTime, hasWalletLimit, hasEligibility, hasKnownName]
  const signalCount   = strongSignals.filter(Boolean).length

  // Objects with 2+ collection meta keys and zero strong signals = metadata, not a stage
  if (metaCount >= 2 && signalCount === 0) {
    return null // rejected: collection metadata object
  }

  // Must have at least one strong signal
  if (signalCount === 0) return null

  // Single-signal acceptance: only accept lone start_time if something else validates it
  if (signalCount === 1 && hasTime && !hasPrice && !hasKnownName && !hasEligibility && !hasWalletLimit) {
    // A lone timestamp from a wrapper object is too ambiguous — require 2+ keys that are stage-specific
    const stageSpecificKeys = keys.filter(k => !COLLECTION_META_KEYS.has(k) &&
      !['name', 'slug', 'id', 'created_at', 'updated_at'].includes(k))
    if (stageSpecificKeys.length < 2) return null // rejected: only metadata + timestamp
  }

  return `signals:${[hasPrice && 'price', hasTime && 'time', hasWalletLimit && 'wallet', hasEligibility && 'eligibility', hasKnownName && 'name'].filter(Boolean).join('+')}`
}

/**
 * Flatten a drops-API `drops[]` array into raw stage candidates.
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
          start_date:  s.start_date || s.start_time || dropStart,
          end_date:    s.end_date   || s.end_time   || dropEnd,
          _drop_price: drop.mint_price ?? drop.price ?? null,
          _drop_max:   drop.max_per_wallet ?? null,
          _source:     'drops_api',
        })
      }
    } else {
      raw.push({ ...drop, _source: 'drops_api' })
    }
  }
  return raw
}

/**
 * Recursively harvest stage candidates from any JSON blob (__NEXT_DATA__, etc.).
 * Walks known stage-container keys; also recurses into Next.js SSR wrappers.
 * Each candidate is validated with validateStageCandidate() before returning.
 */
function harvestFromJson(node, depth = 0, source = '__next_data__') {
  if (!node || typeof node !== 'object' || depth > 14) return []
  const results = []

  if (Array.isArray(node)) {
    for (const item of node) {
      const reason = validateStageCandidate(item)
      if (reason) {
        results.push({ ...item, _source: source, _validation: reason })
      } else {
        results.push(...harvestFromJson(item, depth + 1, source))
      }
    }
    return results
  }

  // Keys that are known to directly contain stage arrays or stage objects
  const STAGE_CONTAINER_KEYS = [
    'stages', 'sale_stages', 'mint_stages', 'saleStages', 'phases',
    'mintSchedule', 'schedule', 'mintStages', 'sale_schedule',
    'allowlist_stages', 'mint_phases',
  ]
  for (const key of STAGE_CONTAINER_KEYS) {
    if (node[key]) results.push(...harvestFromJson(node[key], depth + 1, source))
  }

  // Keys that may contain drop/stage info at single-object level
  const SINGLE_STAGE_KEYS = ['drop', 'mint', 'activeDrop', 'currentDrop', 'mintInfo']
  for (const key of SINGLE_STAGE_KEYS) {
    if (node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) {
      const reason = validateStageCandidate(node[key])
      if (reason) {
        results.push({ ...node[key], _source: source, _validation: reason })
      } else {
        results.push(...harvestFromJson(node[key], depth + 1, source))
      }
    }
  }

  // Recurse into Next.js SSR/hydration wrapper keys
  const WRAPPER_KEYS = [
    'drops', 'collection', 'initialData', 'pageProps', 'props',
    'data', 'event', 'nft', 'launchpad', 'ssrLazyProps',
    'dehydratedState', 'initialState', 'serverSideProps',
    'initialProps', 'queries',
  ]
  for (const key of WRAPPER_KEYS) {
    if (node[key] && typeof node[key] === 'object') {
      results.push(...harvestFromJson(node[key], depth + 1, source))
    }
  }

  return results
}

/**
 * THE source of truth for all OpenSea stage data.
 *
 * Input:  rawList — validated stage candidate objects from any source
 * Output: normalized, deduplicated, time-sorted stage array
 *
 * Each stage: { name, status, start_time, end_time, price, token,
 *               max_per_wallet, eligibility, wl_type, source }
 *
 * Rules:
 * - Status computed from timestamps only; API status used only as last resort
 * - Text detection NEVER called here — happens upstream after stages = []
 * - Stages with no name AND no price AND no time are dropped (post-validation)
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
    const price     = extractAllPrices(s) ??
                      (s._drop_price != null ? normalizeEthPrice(s._drop_price) : null)
    const maxWallet = s.max_per_wallet ?? s._drop_max ?? null
    const allowRaw  = s.allowlist_type || s.sale_type || s.eligibility || null
    const source    = s._source || 'unknown'

    // Final validation: skip if nothing meaningful after normalization
    const hasAnyContent = rawName || startRaw || endRaw || price != null ||
                          maxWallet != null || allowRaw
    if (!hasAnyContent) continue

    // Deduplicate by (start, end, price, name) fingerprint
    const fp = `${startRaw}|${endRaw}|${price}|${rawName}`
    if (seen.has(fp)) continue
    seen.add(fp)

    // Status: timestamps first, API status only if no timestamps
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
      source,
    })
  }

  // Sort: live → upcoming (by start) → ended → unknown
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
 * Unified OpenSea resolver.
 *
 * Fires ALL three sources in parallel (not sequential fallbacks):
 *   1. OpenSea collection API  (metadata: name, chain, contract, image)
 *   2. OpenSea drops API       (structured stage data, requires API key)
 *   3. OpenSea page HTML       (__NEXT_DATA__ + text fallback, no key needed)
 *
 * normalizeOpenSeaStages() is the ONLY consumer of raw stage data.
 * Text detection runs ONLY when structured stages = [] after all sources.
 * live_now is NEVER produced from text alone when stages exist.
 *
 * Returns full debug_opensea_extraction block with rejection tracking.
 */
async function resolveOpenSeaStages(slug, pageUrl, token = 'ETH') {
  const debug = {
    sources_called:             [],
    api_key_present:            Boolean(OPENSEA_KEY),
    candidates_found:           0,
    candidates_rejected:        0,
    rejection_reasons:          [],
    accepted_stages:            0,
    selected_stage:             null,
    price_candidates:           [],
    time_candidates:            [],
    schedule_exposed:           false,
    needs_manual_confirmation:  false,
    final_reason:               null,
  }

  // Fire all three sources in parallel
  const [dropsResult, pageResult] = await Promise.allSettled([
    // ── Source 1: Drops API ────────────────────────────────────────────────
    OPENSEA_KEY
      ? fetch(
          `https://api.opensea.io/api/v2/drops?collection_slug=${encodeURIComponent(slug)}&limit=20`,
          { headers: { 'X-API-KEY': OPENSEA_KEY, accept: 'application/json' },
            signal: AbortSignal.timeout(6000) }
        ).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),

    // ── Source 2: Page HTML ────────────────────────────────────────────────
    fetch(pageUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    }).then(r => r.ok ? r.text() : '').catch(() => ''),
  ])

  const dropsJson  = dropsResult.status === 'fulfilled' ? dropsResult.value  : null
  const pageHtml   = pageResult.status  === 'fulfilled' ? pageResult.value   : ''

  // Track what was called
  if (OPENSEA_KEY) debug.sources_called.push('drops_api')
  debug.sources_called.push('page_html')

  // ── Harvest raw candidates ─────────────────────────────────────────────
  const rawCandidates = []
  const rejectedLog   = []

  // From drops API
  if (dropsJson) {
    debug.sources_called.push('drops_api:ok')
    const fromDrops = harvestFromDropsApi(Array.isArray(dropsJson.drops) ? dropsJson.drops : [])
    rawCandidates.push(...fromDrops)
  }

  // From __NEXT_DATA__
  let pageText = ''
  if (pageHtml) {
    pageText = pageHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 100_000)

    const nextData = extractNextData(pageHtml)
    if (nextData) {
      debug.sources_called.push('__next_data__:ok')
      const fromPage = harvestFromJson(nextData)
      rawCandidates.push(...fromPage)
    } else {
      debug.sources_called.push('__next_data__:not_found')
    }
  }

  // ── Re-validate candidates and track rejections ────────────────────────
  // (harvestFromJson already validates, but drops API candidates need checking too)
  const validatedCandidates = []
  for (const c of rawCandidates) {
    if (c._validation) {
      // Already validated by harvestFromJson
      validatedCandidates.push(c)
    } else {
      // Drops API candidates — validate now
      const reason = validateStageCandidate(c)
      if (reason) {
        validatedCandidates.push({ ...c, _validation: reason })
      } else {
        rejectedLog.push({
          keys:   Object.keys(c).filter(k => !k.startsWith('_')).slice(0, 8),
          reason: 'failed_stage_validation',
        })
      }
    }
  }

  debug.candidates_found    = rawCandidates.length
  debug.candidates_rejected = rawCandidates.length - validatedCandidates.length
  debug.rejection_reasons   = rejectedLog
  debug.price_candidates    = validatedCandidates.map(s => extractAllPrices(s)).filter(Boolean)
  debug.time_candidates     = validatedCandidates
    .map(s => s.start_date || s.start_time).filter(Boolean).slice(0, 10)

  // ── Normalize ──────────────────────────────────────────────────────────
  const stages = normalizeOpenSeaStages(validatedCandidates, token)
  debug.accepted_stages  = stages.length
  debug.schedule_exposed = stages.length > 0

  // ── No structured stages → text fallback (last resort) ────────────────
  if (!stages.length) {
    debug.needs_manual_confirmation = true
    debug.final_reason = 'no_structured_stages_found'
    debug.sources_called.push('text_fallback')

    if (pageText) {
      const textStatus = detectTextStatus(pageText)

      if (textStatus === 'upcoming') {
        const cd = parseCountdown(pageText)
        const approxStart = cd?.totalMs > 30_000
          ? new Date(Date.now() + cd.totalMs).toISOString() : null
        debug.selected_stage = { source: 'text_countdown', countdown: cd?.text }
        debug.final_reason   = 'text_countdown_detected'
        return {
          stages: [], mint_status: 'upcoming',
          mint_date: approxStart, countdown_text: cd?.text || null,
          has_wl_phase: false, schedule_exposed: false,
          needs_manual_confirmation: true,
          debug_opensea_extraction: debug,
        }
      }

      // NOTE: live_now from TEXT alone is intentionally NOT produced here.
      // "Minting" in page text is ambiguous; only timestamps confirm live state.
      if (textStatus === 'ended') {
        debug.selected_stage = { source: 'text_ended' }
        debug.final_reason   = 'text_ended_detected'
        return {
          stages: [], mint_status: 'ended', has_wl_phase: false,
          schedule_exposed: false, needs_manual_confirmation: true,
          debug_opensea_extraction: debug,
        }
      }

      if (textStatus === 'tba') {
        debug.final_reason = 'text_tba_detected'
        return {
          stages: [], mint_status: 'tba', has_wl_phase: false,
          schedule_exposed: false, needs_manual_confirmation: true,
          debug_opensea_extraction: debug,
        }
      }
    }

    // ── Browser render extractor fallback ────────────────────────────────
    if (RENDER_EXTRACTOR_URL) {
      debug.sources_called.push('render_extractor:attempt')
      try {
        const extractUrl = `${RENDER_EXTRACTOR_URL.replace(/\/$/, '')}/extract?url=${encodeURIComponent(pageUrl)}`
        const headers = { 'Content-Type': 'application/json' }
        if (RENDER_EXTRACTOR_SECRET) headers['X-Extractor-Secret'] = RENDER_EXTRACTOR_SECRET
        const renderRes = await fetch(extractUrl, {
          headers,
          signal: AbortSignal.timeout(30_000),
        })
        if (renderRes.ok) {
          const renderData = await renderRes.json()
          debug.sources_called.push('render_extractor:ok')
          if (renderData.schedule_exposed && Array.isArray(renderData.stages) && renderData.stages.length > 0) {
            debug.schedule_exposed           = true
            debug.needs_manual_confirmation  = renderData.needs_manual_confirmation ?? false
            debug.final_reason               = 'render_extractor_stages'
            debug.accepted_stages            = renderData.stages.length
            return {
              stages:                   renderData.stages,
              current_stage:            renderData.current_stage            || null,
              next_stage:               renderData.next_stage               || null,
              mint_status:              renderData.mint_status              || null,
              mint_date:                renderData.mint_date                || null,
              end_date:                 renderData.end_date                 || null,
              mint_price:               renderData.mint_price               || null,
              max_per_wallet:           renderData.max_per_wallet           || null,
              has_wl_phase:             renderData.has_wl_phase             ?? false,
              countdown_text:           renderData.countdown_text           || null,
              schedule_exposed:         true,
              needs_manual_confirmation: renderData.needs_manual_confirmation ?? false,
              debug_opensea_extraction:  debug,
            }
          }
          // Render extractor ran but found no stages — absorb any text signals it returned
          debug.sources_called.push('render_extractor:no_stages')
          if (renderData.mint_status && renderData.mint_status !== 'unknown') {
            debug.final_reason = `render_extractor_text:${renderData.mint_status}`
            return {
              stages: [], mint_status: renderData.mint_status,
              mint_date:     renderData.mint_date     || null,
              countdown_text: renderData.countdown_text || null,
              has_wl_phase: false, schedule_exposed: false,
              needs_manual_confirmation: true,
              debug_opensea_extraction: debug,
            }
          }
        } else {
          debug.sources_called.push(`render_extractor:http_${renderRes.status}`)
        }
      } catch (err) {
        debug.sources_called.push(`render_extractor:error:${err.message?.slice(0, 60)}`)
      }
    }

    debug.final_reason = 'no_signal_found'
    return {
      stages: [], mint_status: null, has_wl_phase: false,
      schedule_exposed: false, needs_manual_confirmation: true,
      debug_opensea_extraction: debug,
    }
  }

  // ── Compute top-level fields from validated stages ─────────────────────
  const now     = Date.now()
  const liveSt  = stages.filter(s => s.status === 'live_now')
  const upcomSt = stages.filter(s => s.status === 'upcoming')
  const endedSt = stages.filter(s => s.status === 'ended')

  const current = liveSt[0]  || null
  const next    = upcomSt[0] || null
  const primary = current || next || stages[0]

  const mintStatus =
    current                            ? 'live_now'
    : next                             ? 'upcoming'
    : endedSt.length === stages.length ? 'ended'
    : 'needs_review'

  const hasWl = stages.some(s => ['GTD', 'FCFS', 'RAFFLE'].includes(s.wl_type))

  // Countdown from actual next_stage start_time — NOT from page text
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
    ? { name: primary.name, status: primary.status, price: primary.price, source: primary.source }
    : null
  debug.final_reason = `stages_ok:${mintStatus}`

  console.log('[opensea-stages] slug=%s status=%s stage=%s price=%s stages=%d sources=%s',
    slug, mintStatus, primary?.name || 'n/a',
    primary?.price ?? 'n/a', stages.length, debug.sources_called.join('+'))

  return {
    stages:          stages.map(s => ({
      name:           s.name,
      status:         s.status,
      start_time:     s.start_time,
      end_time:       s.end_time,
      price:          s.price,
      token:          s.token,
      max_per_wallet: s.max_per_wallet,
      eligibility:    s.eligibility,
      wl_type:        s.wl_type,
      source:         s.source,
    })),
    current_stage:             current?.name || null,
    next_stage:                next?.name    || null,
    mint_status:               mintStatus,
    mint_date:                 primary?.start_time || null,
    end_date:                  primary?.end_time   || null,
    mint_price:                primary?.price      || null,
    stage_name:                primary?.raw_name   || null,
    max_per_wallet:            primary?.max_per_wallet || null,
    has_wl_phase:              hasWl,
    countdown_text:            countdownText,
    schedule_exposed:          true,
    needs_manual_confirmation: false,
    debug_opensea_extraction:  debug,
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

      // All three sources are fired in parallel inside resolveOpenSeaStages:
      //   drops API + page __NEXT_DATA__ + page HTML.
      // fetchOpenSea (collection metadata) runs concurrently alongside.
      const [api, stageResult] = await Promise.all([
        fetchOpenSea(slug),
        resolveOpenSeaStages(slug, url, 'ETH'),  // token corrected after chain resolved
      ])

      const chain = api?.chain || 'eth'
      const token = chain === 'bnb' ? 'BNB' : 'ETH'

      // Re-stamp stages with correct token once chain is known
      const stages = (stageResult.stages || []).map(s => ({ ...s, token }))

      const mintStatus             = stageResult.mint_status              || null
      const mintDate               = stageResult.mint_date                || null
      const endDate                = stageResult.end_date                 || null
      const mintPrice              = stageResult.mint_price               || null
      const stageName              = stageResult.stage_name               || null
      const countdownText          = stageResult.countdown_text           || null
      const scheduleExposed        = stageResult.schedule_exposed         ?? stages.length > 0
      const needsManualConfirm     = stageResult.needs_manual_confirmation ?? !scheduleExposed

      const isLiveNow   = mintStatus === 'live_now'
      const hasContract = Boolean(api?.contract_address || urlContract)
      const hasDate     = Boolean(mintDate)
      const hasPrice    = Boolean(mintPrice) || stages.some(s => s.price != null)

      // Price note: specific message if schedule not exposed vs just missing price
      const priceNote = hasPrice ? null
        : scheduleExposed ? 'Price not set in OpenSea schedule'
        : 'OpenSea did not expose mint schedule. Open source to confirm.'

      console.log('[opensea-resolver]', JSON.stringify({
        slug, chain, token,
        status:          mintStatus || 'none',
        stages:          stages.length,
        price:           mintPrice  || 'none',
        schedule:        scheduleExposed,
        manual_confirm:  needsManualConfirm,
        sources:         stageResult.debug_opensea_extraction?.sources_called || [],
        selected:        stageResult.debug_opensea_extraction?.selected_stage || null,
        rejected:        stageResult.debug_opensea_extraction?.candidates_rejected || 0,
      }))

      // Build shared fields used in both API and no-API return paths
      const sharedStageFields = {
        mint_status:               mintStatus,
        mint_date:                 mintDate,
        end_date:                  endDate,
        mint_price:                mintPrice,
        price_note:                priceNote,
        countdown_text:            countdownText,
        mint_phase:                stageName ? stageToMintPhase(stageName) : null,
        wl_type:                   stageName ? stageToWlType(stageName)    : 'UNKNOWN',
        max_per_wallet:            stageResult.max_per_wallet  || null,
        stages,
        has_wl_phase:              stageResult.has_wl_phase    || false,
        current_stage:             stageResult.current_stage   || null,
        next_stage:                stageResult.next_stage      || null,
        schedule_exposed:          scheduleExposed,
        needs_manual_confirmation: needsManualConfirm,
        debug_opensea_extraction:  stageResult.debug_opensea_extraction,
      }

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
          ...sharedStageFields,
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
        }
      }

      // No collection API key — slug-derived name + stage data only
      const slugName = slug.split('-').map(w => (w[0] || '').toUpperCase() + w.slice(1)).join(' ')

      if (mintStatus || mintDate || stages.length) {
        return {
          name:             slugName,
          source_type:      'opensea',
          chain:            'eth',
          contract_address: urlContract,
          ...sharedStageFields,
          notes:            `OpenSea collection: ${slug}`,
          confidence: {
            name:             'url_extracted',
            chain:            'url_extracted',
            contract_address: urlContract ? 'url_extracted' : 'missing',
            mint_date:        mintDate    ? 'low' : mintStatus ? 'page_detected' : 'missing',
            mint_price:       hasPrice    ? 'low' : 'missing',
          },
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
        }
      }

      // Pure slug fallback — no schedule data found at all
      return {
        name:                      slugName,
        source_type:               'opensea',
        chain:                     'eth',
        contract_address:          urlContract,
        price_note:                'OpenSea did not expose mint schedule. Open source to confirm.',
        schedule_exposed:          false,
        needs_manual_confirmation: true,
        notes:                     `OpenSea collection: ${slug}`,
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
