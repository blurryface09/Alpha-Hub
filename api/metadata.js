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

function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

// ════════════════════════════════════════════════════════════════════════════
// OPENSEA API FETCHERS
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

/**
 * OpenSea v2 drops response schema:
 *   { drops: [{ contract, start_date, end_date, mint_price,
 *               stages: [{ stage, start_date, end_date, mint_price,
 *                          price, price_per_token, native_price,
 *                          max_per_wallet, allowlist_type, sale_config }] }] }
 */
async function fetchOpenSeaDrops(slug) {
  if (!OPENSEA_KEY) return null
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/drops?collection_slug=${encodeURIComponent(slug)}&limit=20`,
      { headers: { 'X-API-KEY': OPENSEA_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(6000) }
    )
    if (!r.ok) {
      console.warn('[opensea-drops] non-ok', r.status, 'slug:', slug)
      return null
    }
    const d    = await r.json()
    const drops = Array.isArray(d.drops) ? d.drops : []
    if (!drops.length) return null

    const now = Date.now()

    // Flatten stages from all drops
    // Each drop may have nested stages[] with field `stage` (the name)
    const allStages = []
    for (const drop of drops) {
      const dropStart    = drop.start_date || drop.start_time || null
      const dropEnd      = drop.end_date   || drop.end_time   || null
      const dropPrice    = extractStagePrice(drop)
      const nestedStages = Array.isArray(drop.stages) && drop.stages.length ? drop.stages : null

      if (nestedStages) {
        for (const s of nestedStages) {
          const rawName = s.stage || s.stage_name || s.name || null
          allStages.push({
            name:           stageDisplayName(rawName),
            raw_name:       rawName,
            start_time:     s.start_date  || s.start_time  || dropStart || null,
            end_time:       s.end_date    || s.end_time    || dropEnd   || null,
            price:          extractStagePrice(s, dropPrice),
            max_per_wallet: s.max_per_wallet || drop.max_per_wallet || null,
          })
        }
      } else {
        const rawName = drop.stage_name || drop.stage || null
        allStages.push({
          name:           stageDisplayName(rawName),
          raw_name:       rawName,
          start_time:     dropStart,
          end_time:       dropEnd,
          price:          dropPrice,
          max_per_wallet: drop.max_per_wallet || null,
        })
      }
    }

    if (!allStages.length) return null

    // Classify by time window
    const liveStage = allStages.find(s => {
      if (!s.start_time) return false
      const start = new Date(s.start_time).getTime()
      const end   = s.end_time ? new Date(s.end_time).getTime() : Infinity
      return start <= now && now < end
    })

    const upcomingStage = allStages
      .filter(s => s.start_time && new Date(s.start_time).getTime() > now)
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0]

    const primary   = liveStage || upcomingStage || allStages.at(-1)
    const isLiveNow = Boolean(liveStage)

    // Only expose stages when ≥2 exist with real names or times
    const cleanStages = allStages
      .filter(s => s.name || s.start_time)
      .map(s => ({ name: s.name, start_time: s.start_time, end_time: s.end_time, price: s.price }))

    const result = {
      mint_status:    isLiveNow ? 'live_now' : upcomingStage ? 'upcoming' : null,
      is_live:        isLiveNow,
      active_stage:   liveStage?.name    || null,
      mint_date:      primary?.start_time || null,
      end_date:       primary?.end_time   || null,
      mint_price:     primary?.price      || null,
      stage_name:     primary?.raw_name   || null,
      max_per_wallet: primary?.max_per_wallet || null,
      stages:         cleanStages.length >= 2 ? cleanStages : null,
    }

    console.log('[opensea-drops] slug=%s status=%s stage=%s start=%s price=%s stages=%d',
      slug, result.mint_status || 'none', result.stage_name || 'n/a',
      result.mint_date || 'n/a', result.mint_price || 'n/a', cleanStages.length
    )

    return result
  } catch (e) {
    console.error('[opensea-drops]', e.message)
    return null
  }
}

// ════════════════════════════════════════════════════════════════════════════
// OPENSEA PAGE SCRAPER (no API key required)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fetches the raw OpenSea page HTML and extracts mint state from:
 *   A. __NEXT_DATA__ hydration JSON (SSR, always present)
 *   B. Structured text patterns ("Minting Now", "Minting in X days Y hours")
 *
 * Returns null when no useful signal found.
 */
async function scrapeOpenSeaPage(pageUrl) {
  try {
    const r = await fetch(pageUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    const html = await r.text()

    // ── A. __NEXT_DATA__ hydration ─────────────────────────────────────────
    const nextData = extractNextData(html)
    if (nextData) {
      const pp   = nextData?.props?.pageProps || {}
      const drop =
        pp.drop || pp.collection?.drop || pp.initialData?.drop ||
        deepFind(pp, 'drop') || null

      if (drop) {
        // Use strict classifier — NOT a broad regex that catches "minting"
        const apiStatus  = classifyDropStatus(drop.status || drop.stage_status || drop.mint_status)
        const startDate  = drop.start_date || drop.start_time || null
        const endDate    = drop.end_date   || drop.end_time   || null
        const rawPrice   = extractStagePrice(drop)
        const stageName  = drop.stage || drop.stage_name || null

        // Check nested stages for a live window
        const now        = Date.now()
        let liveStage    = null
        for (const s of (Array.isArray(drop.stages) ? drop.stages : [])) {
          const st = s.start_date || s.start_time
          const et = s.end_date   || s.end_time
          if (st && new Date(st).getTime() <= now && (!et || new Date(et).getTime() > now)) {
            liveStage = s; break
          }
        }

        const resolvedStatus = liveStage ? 'live_now' : apiStatus
        const price = liveStage ? extractStagePrice(liveStage, rawPrice) : rawPrice

        if (resolvedStatus || startDate) {
          const res = {
            mint_status: resolvedStatus,
            mint_date:   liveStage?.start_date || startDate || null,
            end_date:    liveStage?.end_date   || endDate   || null,
            mint_price:  price,
            stage_name:  liveStage?.stage || stageName || null,
            source:      'page_next_data',
          }
          console.log('[scrape-opensea] NEXT_DATA drop: status=%s start=%s price=%s',
            res.mint_status || 'none', res.mint_date || 'n/a', res.mint_price || 'n/a')
          return res
        }
      }
    }

    // ── B. HTML text scan ─────────────────────────────────────────────────
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 100_000)

    const textStatus = detectTextStatus(stripped)

    // Countdown → upcoming with computed approximate start time
    if (textStatus === 'upcoming') {
      const countdown = parseCountdown(stripped)
      const approxStart = countdown && countdown.totalMs > 30_000
        ? new Date(Date.now() + countdown.totalMs).toISOString()
        : null

      console.log('[scrape-opensea] countdown detected: %s → approx start %s',
        countdown?.text || 'unknown', approxStart || 'n/a')

      return {
        mint_status:       'upcoming',
        mint_date:         approxStart,           // approximate — low confidence
        countdown_text:    countdown?.text || null,
        countdown_detected: true,
        source:            'page_countdown',
        confidence:        approxStart ? 'low' : 'page_text',
      }
    }

    if (textStatus === 'live_now') {
      console.log('[scrape-opensea] live keyword detected in page text')
      return { mint_status: 'live_now', source: 'page_text', confidence: 'medium' }
    }

    if (textStatus === 'ended') {
      return { mint_status: 'ended', source: 'page_text', confidence: 'medium' }
    }

    if (textStatus === 'tba') {
      return { mint_status: 'tba', source: 'page_text', confidence: 'low' }
    }

    return null
  } catch (e) {
    console.warn('[scrape-opensea] failed:', e.message)
    return null
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

      // A. API: collection + drops in parallel
      const [api, drop] = await Promise.all([fetchOpenSea(slug), fetchOpenSeaDrops(slug)])

      // B. Page scrape only when API gave no timing or status
      let pageMint = null
      if (!drop?.mint_date && !drop?.is_live && !drop?.mint_status) {
        pageMint = await scrapeOpenSeaPage(url)
      }

      // Merge — API wins over page scrape
      const mintStatus    = drop?.mint_status   || pageMint?.mint_status   || null
      const mintDate      = drop?.mint_date     || pageMint?.mint_date     || null
      const endDate       = drop?.end_date      || pageMint?.end_date      || null
      const mintPrice     = drop?.mint_price    || pageMint?.mint_price    || null
      const stageName     = drop?.stage_name    || pageMint?.stage_name    || null
      const countdownText = pageMint?.countdown_text || null

      const isLiveNow     = mintStatus === 'live_now'
      const isUpcoming    = mintStatus === 'upcoming'
      const hasContract   = Boolean(api?.contract_address || urlContract)
      const hasDate       = Boolean(mintDate)
      const hasPrice      = Boolean(mintPrice)
      // "price not exposed" note for OpenSea when we have no price
      const priceNote     = !hasPrice ? 'Price not exposed by OpenSea' : null

      // ── Structured debug log ────────────────────────────────────────────
      console.log('[opensea-resolver]', JSON.stringify({
        source:             'opensea',
        slug,
        contract:           api?.contract_address || urlContract || null,
        status:             mintStatus   || 'none',
        interpreted_status: isLiveNow   ? 'live_now'
                          : isUpcoming  ? 'upcoming'
                          : hasDate     ? 'upcoming'
                          : 'unknown',
        matched_text:       pageMint?.source || (drop ? 'drops_api' : 'none'),
        countdown:          countdownText || null,
        start_time:         mintDate     || null,
        end_time:           endDate      || null,
        phase:              stageName    || null,
        stage_name:         stageName    || null,
        stage_status:       mintStatus   || null,
        raw_price:          drop?.mint_price ?? pageMint?.mint_price ?? null,
        normalized_price:   mintPrice    || null,
        token:              api?.chain === 'bnb' ? 'BNB' : 'ETH',
        missing_fields: [
          ...(!hasDate && !isLiveNow ? ['mint_date']       : []),
          ...(!hasPrice              ? ['mint_price']       : []),
          ...(!hasContract           ? ['contract_address'] : []),
        ],
        confidence:  hasDate       ? 'api_verified'
                   : isLiveNow     ? 'page_detected'
                   : countdownText ? 'low'
                   : 'missing',
        reason:      isLiveNow     ? 'live_now_confirmed'
                   : isUpcoming    ? 'upcoming_scheduled'
                   : hasDate       ? 'upcoming_scheduled'
                   : countdownText ? 'countdown_detected'
                   : pageMint      ? 'page_scraped'
                   : 'timing_unknown',
      }))

      if (api) {
        return {
          name:             api.name,
          source_type:      'opensea',
          chain:            api.chain,
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
          max_per_wallet:   drop?.max_per_wallet || null,
          stages:           drop?.stages         || null,
          notes:            api.description?.slice(0, 120) || `OpenSea: ${slug}`,
          confidence: {
            name:             'api_verified',
            chain:            'api_verified',
            contract_address: api.contract_address ? 'api_verified'
                            : urlContract          ? 'url_extracted' : 'missing',
            mint_date:        hasDate       ? 'api_verified'
                            : isLiveNow     ? 'api_verified'
                            : countdownText ? 'low'       : 'missing',
            mint_price:       hasPrice      ? 'api_verified' : 'missing',
          },
          missing_fields: [
            ...(!hasDate && !isLiveNow ? ['mint_date']       : []),
            ...(!hasPrice              ? ['mint_price']       : []),
            ...(!hasContract           ? ['contract_address'] : []),
          ],
        }
      }

      // No API key — page-scrape result or slug fallback
      if (pageMint?.mint_status || pageMint?.mint_date) {
        const name = slug.split('-').map(w => (w[0] || '').toUpperCase() + w.slice(1)).join(' ')
        const pm   = pageMint
        return {
          name,
          source_type:      'opensea',
          chain:            'eth',
          contract_address: urlContract,
          mint_status:      pm.mint_status   || null,
          mint_date:        pm.mint_date     || null,
          end_date:         pm.end_date      || null,
          mint_price:       pm.mint_price    || null,
          price_note:       pm.mint_price    ? null : 'Price not exposed by OpenSea',
          countdown_text:   pm.countdown_text || null,
          notes:            `OpenSea collection: ${slug}`,
          confidence: {
            name:             'url_extracted',
            chain:            'url_extracted',
            contract_address: urlContract     ? 'url_extracted' : 'missing',
            mint_date:        pm.mint_date    ? 'low'
                            : pm.mint_status  ? 'page_detected'  : 'missing',
            mint_price:       pm.mint_price   ? 'low'            : 'missing',
          },
          missing_fields: [
            ...(!pm.mint_date && !pm.mint_status ? ['mint_date'] : []),
            ...(!pm.mint_price                    ? ['mint_price'] : []),
            ...(!urlContract                      ? ['contract_address'] : []),
          ],
        }
      }

      // Pure slug fallback
      const name = slug.split('-').map(w => (w[0] || '').toUpperCase() + w.slice(1)).join(' ')
      return {
        name,
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
