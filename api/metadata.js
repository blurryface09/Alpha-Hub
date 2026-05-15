// api/metadata.js — Server-side project metadata extractor
// Supports: OpenSea (API + page scrape), Zora, Magic Eden, Twitter/X,
//           direct 0x contract address, plain alpha text, generic URLs

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

// ── Stage → DB wl_type (constrained enum: GTD | FCFS | PUBLIC | RAFFLE | UNKNOWN) ──
function stageToWlType(stage) {
  const s = String(stage || '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s.includes('gtd') || s.includes('guaranteed'))                       return 'GTD'
  if (s.includes('fcfs'))                                                   return 'FCFS'
  if (s.includes('raffle'))                                                 return 'RAFFLE'
  if (s.includes('allow') || s.includes('whitelist') || s === 'wl' ||
      s.includes('private') || s.includes('presale'))                       return 'GTD'
  if (s.includes('public') || s.includes('open') || s.includes('claim'))   return 'PUBLIC'
  return 'UNKNOWN'
}

// ── Stage → display mint_phase (no DB constraint) ───────────────────────────────
function stageToMintPhase(stage) {
  const s = String(stage || '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s.includes('gtd') || s.includes('guaranteed'))              return 'gtd'
  if (s.includes('allow') || s.includes('whitelist') || s === 'wl' ||
      s.includes('private') || s.includes('presale'))             return 'wl'
  if (s.includes('public') && s.includes('fcfs'))                 return 'public_fcfs'
  if (s.includes('fcfs'))                                         return 'wl_fcfs'
  if (s.includes('open_edition') || (s.includes('open') && s.includes('edition'))) return 'open_edition'
  if (s.includes('claim'))                                        return 'claim'
  if (s.includes('public'))                                       return 'public'
  return 'unknown'
}

// ── Friendly stage display label ───────────────────────────────────────────────
function stageDisplayName(stageName) {
  if (!stageName) return null
  const s = String(stageName).toLowerCase().trim()
  if (s === 'public')     return 'Public'
  if (s === 'allowlist' || s === 'allow_list') return 'Allowlist'
  if (s === 'whitelist')  return 'Whitelist'
  if (s === 'presale')    return 'Presale'
  if (s === 'fcfs')       return 'FCFS'
  if (s === 'gtd' || s === 'guaranteed') return 'GTD'
  if (s === 'open_edition' || s === 'openedition') return 'Open Edition'
  if (s === 'claim')      return 'Claim'
  if (s === 'raffle')     return 'Raffle'
  // Title-case unknown names rather than showing raw snake_case
  return stageName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── HTML decode helper ─────────────────────────────────────────────────────────
function decodeHtml(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// ── Extract __NEXT_DATA__ from HTML ────────────────────────────────────────────
function extractNextData(html) {
  const m = String(html || '').match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return null
  try { return JSON.parse(decodeHtml(m[1])) } catch { return null }
}

// ── Deep-search an object for a key ─────────────────────────────────────────────
function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

// ── OpenSea Collection metadata ───────────────────────────────────────────────
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

// ── OpenSea Drops API — correct field mapping ─────────────────────────────────
// OpenSea v2 drops response:
//   { drops: [{ contract, start_date, end_date, mint_price, stages: [{
//       stage, start_date, end_date, mint_price, max_per_wallet, allowlist_type
//   }] }] }
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
    const d = await r.json()
    const drops = Array.isArray(d.drops) ? d.drops : []
    if (!drops.length) return null

    const now = Date.now()

    // Flatten all stages from all drops into a single list
    // Stages are nested: drops[i].stages[j] with field `stage` (the name)
    // Fall back to drop-level fields when no nested stages array
    const allStages = []
    for (const drop of drops) {
      const dropStart = drop.start_date || drop.start_time || null
      const dropEnd   = drop.end_date   || drop.end_time   || null
      const dropPrice = drop.mint_price != null ? String(drop.mint_price) : null

      const nestedStages = Array.isArray(drop.stages) && drop.stages.length ? drop.stages : null

      if (nestedStages) {
        for (const s of nestedStages) {
          // `s.stage` is the name field in OpenSea v2 stage objects
          const rawName = s.stage || s.stage_name || s.name || null
          allStages.push({
            name:           stageDisplayName(rawName),
            raw_name:       rawName,
            start_time:     s.start_date  || s.start_time  || dropStart || null,
            end_time:       s.end_date    || s.end_time    || dropEnd   || null,
            price:          s.mint_price != null ? String(s.mint_price) : dropPrice,
            max_per_wallet: s.max_per_wallet || drop.max_per_wallet || null,
          })
        }
      } else {
        // No nested stages — use drop-level fields directly
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

    // Classify each stage as live / upcoming / ended
    const liveStage = allStages.find(s => {
      if (!s.start_time) return false
      const start = new Date(s.start_time).getTime()
      const end   = s.end_time ? new Date(s.end_time).getTime() : Infinity
      return start <= now && now < end
    })

    const upcomingStage = allStages
      .filter(s => s.start_time && new Date(s.start_time).getTime() > now)
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0]

    const primary    = liveStage || upcomingStage || allStages.at(-1)
    const isLiveNow  = Boolean(liveStage)

    // Build clean stage list (only stages with a real name OR real timing)
    const cleanStages = allStages
      .filter(s => s.name || s.start_time)
      .map(s => ({
        name:       s.name       || null,
        start_time: s.start_time || null,
        end_time:   s.end_time   || null,
        price:      s.price      || null,
      }))

    const result = {
      mint_status:    isLiveNow ? 'live_now' : null,
      is_live:        isLiveNow,
      active_stage:   liveStage?.name    || null,
      mint_date:      primary?.start_time || null,
      end_date:       primary?.end_time   || null,
      mint_price:     primary?.price      || null,
      stage_name:     primary?.raw_name   || null,
      max_per_wallet: primary?.max_per_wallet || null,
      stages:         cleanStages.length >= 2 ? cleanStages : null, // only show if multi-stage
    }

    console.log('[opensea-drops] slug=%s status=%s stage=%s start=%s price=%s stages=%d',
      slug,
      result.mint_status  || 'none',
      result.stage_name   || 'n/a',
      result.mint_date    || 'n/a',
      result.mint_price   || 'n/a',
      cleanStages.length
    )

    return result
  } catch (e) {
    console.error('[opensea-drops]', e.message)
    return null
  }
}

// ── OpenSea page scraper — works even without API key ─────────────────────────
// Reads __NEXT_DATA__ hydration blob and HTML text to determine mint state.
// OpenSea embeds rich drop/stage state in the raw HTML for Next.js SSR.
async function scrapeOpenSeaPage(pageUrl) {
  try {
    const r = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(9000),
    })
    if (!r.ok) return null
    const html = await r.text()

    // 1. Try __NEXT_DATA__ hydration JSON
    const nextData = extractNextData(html)
    if (nextData) {
      // OpenSea stores drop info under several possible keys in pageProps
      const pp = nextData?.props?.pageProps || {}

      // Possible drop locations in different OpenSea page versions
      const drop =
        pp.drop ||
        pp.collection?.drop ||
        pp.initialData?.drop ||
        deepFind(pp, 'drop') ||
        null

      if (drop) {
        const status    = drop.status || drop.stage_status || drop.mint_status || null
        const isLive    = /live|minting|active|open/i.test(String(status || ''))
        const startDate = drop.start_date || drop.start_time || null
        const endDate   = drop.end_date   || drop.end_time   || null
        const price     = drop.mint_price != null ? String(drop.mint_price) : null
        const stageName = drop.stage || drop.stage_name || null

        // Also try nested stages in the drop
        let liveStageFromPage = null
        const dropStages = Array.isArray(drop.stages) ? drop.stages : []
        const now = Date.now()
        for (const s of dropStages) {
          const st = s.start_date || s.start_time
          const et = s.end_date   || s.end_time
          if (st && new Date(st).getTime() <= now && (!et || new Date(et).getTime() > now)) {
            liveStageFromPage = s
            break
          }
        }

        const confirmed_live = isLive || Boolean(liveStageFromPage)

        if (confirmed_live || startDate) {
          const result = {
            mint_status: confirmed_live ? 'live_now' : null,
            mint_date:   liveStageFromPage?.start_date || startDate || null,
            end_date:    liveStageFromPage?.end_date   || endDate   || null,
            mint_price:  liveStageFromPage?.mint_price != null
              ? String(liveStageFromPage.mint_price)
              : price,
            stage_name:  liveStageFromPage?.stage || stageName || null,
            source:      'page_next_data',
          }
          console.log('[scrape-opensea] __NEXT_DATA__ drop found: status=%s start=%s price=%s',
            result.mint_status || 'none',
            result.mint_date   || 'n/a',
            result.mint_price  || 'n/a'
          )
          return result
        }
      }

      // Try collection-level supply info (helps confirm project exists)
      const collection = pp.collection || deepFind(pp, 'collection')
      if (collection?.name) {
        console.log('[scrape-opensea] found collection name from __NEXT_DATA__:', collection.name)
      }
    }

    // 2. HTML text keyword scan (stripped of tags)
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 80_000)

    const liveRe = /minting\s+now|mint\s+(is\s+)?live|public\s+mint\s+live|sale\s+live|mint\s+open|minting\s+open|live\s+mint/i
    if (liveRe.test(stripped)) {
      console.log('[scrape-opensea] live keyword detected in page text')
      return { mint_status: 'live_now', source: 'page_text', confidence: 'medium' }
    }

    const soldOutRe = /sold\s+out|mint\s+ended|sale\s+ended|fully\s+minted/i
    if (soldOutRe.test(stripped)) {
      return { mint_status: 'ended', source: 'page_text', confidence: 'medium' }
    }

    return null
  } catch (e) {
    console.warn('[scrape-opensea] failed:', e.message)
    return null
  }
}

// ── Groq AI fallback ──────────────────────────────────────────────────────────
async function callGroq(prompt, maxTokens = 256) {
  if (!GROQ_KEY) return null
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
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

// ── Direct contract address input ─────────────────────────────────────────────
async function detectContractInput(address) {
  const ai = await callGroq(
    `NFT or crypto project contract address: ${address}\n` +
    `Return ONLY valid JSON:\n` +
    `{"name":null,"chain":"eth"|"base"|"bnb"|null,"notes":null}`,
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

// ── Plain alpha text ──────────────────────────────────────────────────────────
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

// ── Main extractor ────────────────────────────────────────────────────────────
async function extractMetadata(rawInput) {
  const input = rawInput.trim()

  // Direct contract address
  if (/^0x[a-fA-F0-9]{40}$/i.test(input)) return detectContractInput(input)

  // Plain alpha text — no URL and no domain pattern
  const looksLikeUrl = /^https?:\/\//i.test(input) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(input)
  if (!looksLikeUrl && input.length > 5) return detectPlainText(input)

  let url = input
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url

  let parsed
  try { parsed = new URL(url) } catch { return fail('Invalid URL') }

  const host        = parsed.hostname.replace(/^www\./, '').toLowerCase()
  const path        = parsed.pathname
  const urlContract = (url.match(/0x[a-fA-F0-9]{40}/) || [])[0] || null

  // ── OpenSea ──────────────────────────────────────────────────────────────────
  if (host === 'opensea.io') {
    const m = path.match(/\/collection\/([^/?#]+)/)
    if (m) {
      const slug = m[1]

      // Fetch collection metadata + drops API in parallel
      const [api, drop] = await Promise.all([fetchOpenSea(slug), fetchOpenSeaDrops(slug)])

      // If drops API gave no live/timing info, try page scraping as fallback
      let pageMint = null
      if (!drop?.mint_date && !drop?.is_live) {
        pageMint = await scrapeOpenSeaPage(url)
      }

      // Merge: API drops > page scrape
      const mintStatus    = drop?.mint_status  || pageMint?.mint_status  || null
      const mintDate      = drop?.mint_date    || pageMint?.mint_date    || null
      const endDate       = drop?.end_date     || pageMint?.end_date     || null
      const mintPrice     = drop?.mint_price   || pageMint?.mint_price   || null
      const stageName     = drop?.stage_name   || pageMint?.stage_name   || null
      const isLiveNow     = mintStatus === 'live_now'

      const hasContract   = Boolean(api?.contract_address || urlContract)
      const hasDate       = Boolean(mintDate)
      const hasPrice      = Boolean(mintPrice)
      const hasLiveStatus = isLiveNow

      // Debug resolver log
      console.log('[opensea-resolver]', JSON.stringify({
        source:        'opensea',
        slug,
        contract:      api?.contract_address || urlContract || null,
        status:        mintStatus  || 'none',
        phase:         stageName   || 'n/a',
        mint_price:    mintPrice   || 'n/a',
        start_time:    mintDate    || 'n/a',
        end_time:      endDate     || 'n/a',
        missing_fields: [
          ...(!hasDate && !hasLiveStatus ? ['mint_date'] : []),
          ...(!hasPrice                  ? ['mint_price'] : []),
          ...(!hasContract               ? ['contract_address'] : []),
        ],
        confidence:    hasDate ? 'api_verified' : hasLiveStatus ? 'page_detected' : 'missing',
        reason:        isLiveNow   ? 'live_now_confirmed'
                     : hasDate     ? 'upcoming_scheduled'
                     : pageMint    ? 'page_scraped'
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
                            : hasLiveStatus ? 'api_verified'  : 'missing',
            mint_price:       hasPrice      ? 'api_verified'  : 'missing',
          },
          missing_fields: [
            ...(!hasDate && !hasLiveStatus ? ['mint_date']       : []),
            ...(!hasPrice                  ? ['mint_price']       : []),
            ...(!hasContract               ? ['contract_address'] : []),
          ],
        }
      }

      // No API key — try page scrape only then slug fallback
      if (pageMint?.mint_status || pageMint?.mint_date) {
        const name = slug.split('-').map(w => (w[0] || '').toUpperCase() + w.slice(1)).join(' ')
        return {
          name,
          source_type:      'opensea',
          chain:            'eth',
          contract_address: urlContract,
          mint_status:      pageMint.mint_status || null,
          mint_date:        pageMint.mint_date   || null,
          end_date:         pageMint.end_date    || null,
          mint_price:       pageMint.mint_price  || null,
          notes:            `OpenSea collection: ${slug}`,
          confidence: {
            name:             'url_extracted',
            chain:            'url_extracted',
            contract_address: urlContract ? 'url_extracted' : 'missing',
            mint_date:        pageMint.mint_date   ? 'url_extracted'
                            : pageMint.mint_status ? 'url_extracted' : 'missing',
            mint_price:       pageMint.mint_price  ? 'url_extracted' : 'missing',
          },
          missing_fields: [
            ...(!pageMint.mint_date && !pageMint.mint_status ? ['mint_date'] : []),
            ...(!pageMint.mint_price                          ? ['mint_price'] : []),
            ...(!urlContract                                  ? ['contract_address'] : []),
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

  // ── Zora ─────────────────────────────────────────────────────────────────────
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
          mint_date:        'missing',
          mint_price:       'missing',
        },
        missing_fields: [
          ...(!ai?.name ? ['name'] : []),
          'mint_date', 'mint_price',
          ...(!addrInPath ? ['contract_address'] : []),
        ],
      }
    }
  }

  // ── Magic Eden ───────────────────────────────────────────────────────────────
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
        name, source_type: 'magiceden', chain,
        contract_address: urlContract,
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

  // ── Twitter / X ──────────────────────────────────────────────────────────────
  if (host === 'twitter.com' || host === 'x.com') {
    const skip = new Set(['i','home','explore','notifications','messages','search','compose','settings','intent'])
    const m = path.match(/^\/([^/?#]+)/)
    if (m && !skip.has(m[1].toLowerCase())) {
      const handle = m[1]
      return {
        name: handle, source_type: 'twitter', chain: 'eth',
        contract_address: urlContract,
        twitter_handle:   `@${handle}`,
        notes:            `Twitter: @${handle}`,
        confidence: {
          name: 'url_extracted', chain: 'missing',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date: 'missing', mint_price: 'missing',
        },
        missing_fields: ['mint_date', 'mint_price', ...(!urlContract ? ['contract_address'] : [])],
      }
    }
  }

  // ── Generic / Groq fallback ───────────────────────────────────────────────────
  const ai = await callGroq(
    `Extract NFT/crypto project metadata from this URL: ${url}\n\n` +
    `Return ONLY valid JSON (null for unknown):\n` +
    `{"name":null,"chain":null,"contract_address":null,"mint_price":null,"notes":null}`
  )
  if (ai?.name) {
    const hasContract = ai.contract_address || urlContract
    return {
      name:             ai.name,
      source_type:      'website',
      chain:            ai.chain            || 'eth',
      contract_address: ai.contract_address || urlContract,
      mint_price:       ai.mint_price       || null,
      notes:            ai.notes            || null,
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

  // Last resort: URL text extraction
  const parts    = path.split('/').filter(Boolean)
  const namePart = parts[parts.length - 1] || host.split('.')[0]
  const fallback = namePart.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return {
    name:             fallback || null,
    source_type:      'website',
    chain:            'eth',
    contract_address: urlContract,
    confidence: {
      name:             fallback    ? 'url_extracted' : 'missing',
      chain:            'missing',
      contract_address: urlContract ? 'url_extracted' : 'missing',
      mint_date:        'missing',
      mint_price:       'missing',
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
    name: null, source_type: 'website', chain: 'eth', contract_address: null,
    error: msg,
    confidence: { name: 'missing', chain: 'missing', contract_address: 'missing', mint_date: 'missing', mint_price: 'missing' },
    missing_fields: ['name', 'chain', 'contract_address', 'mint_date', 'mint_price'],
  }
}

// ── Vercel handler ────────────────────────────────────────────────────────────
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
