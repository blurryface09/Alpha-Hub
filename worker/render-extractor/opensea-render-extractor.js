/**
 * worker/opensea-render-extractor.js
 *
 * Railway HTTP service — Playwright browser-render extractor for OpenSea.
 *
 * Problem: OpenSea renders mint schedule (stages, prices, times, limits) via
 * client-side React. Server HTML and the drops API often omit this data.
 * This service opens the URL in a real Chromium browser, waits for the schedule
 * to render, and extracts structured stage data.
 *
 * Deploy as a separate Railway service with the Dockerfile in this directory.
 * Set RENDER_EXTRACTOR_URL in Vercel/Railway to point to this service's URL.
 * Set RENDER_EXTRACTOR_SECRET (optional) to require a shared secret.
 *
 * GET/POST /extract?url=<opensea_url>
 * POST     /extract  { url }
 *
 * Returns: { schedule_exposed, stages[], mint_status, mint_date, end_date,
 *            mint_price, countdown_text, has_wl_phase, max_per_wallet,
 *            current_stage, next_stage, debug }
 *
 * UAT:
 *   Pass: summary-only metadata → stages=[] schedule_exposed=false
 *   Pass: single real stage     → 1 stage shown, price/time populated
 *   Pass: multi-stage drop      → all stages shown with wl_type
 *   Pass: countdown page        → upcoming, countdown_text set
 *   Pass: live timestamp window → live_now (from time comparison)
 *   Pass: all stages ended      → ended status
 *   Pass: free mint             → price="0", displayed as "Free"
 *   Pass: no schedule           → schedule_exposed=false, needs_manual_confirmation=true
 */

import { chromium } from 'playwright'
import http          from 'http'
import { URL }       from 'url'

const PORT   = Number(process.env.PORT || 3001)
const SECRET = process.env.RENDER_EXTRACTOR_SECRET || ''   // optional shared secret
const MAX_MS = Number(process.env.EXTRACTOR_TIMEOUT_MS || 14000)

// ────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────────────────────

// Ordered by specificity — more specific patterns first
const STAGE_DEFS = [
  { re: /^public\s+sale$/i,       name: 'Public',       wl: 'PUBLIC' },
  { re: /^public$/i,              name: 'Public',       wl: 'PUBLIC' },
  { re: /^allow\s*list\s*sale$/i, name: 'Allowlist',    wl: 'GTD'   },
  { re: /^allow\s*list$/i,        name: 'Allowlist',    wl: 'GTD'   },
  { re: /^allowlist$/i,           name: 'Allowlist',    wl: 'GTD'   },
  { re: /^white\s*list$/i,        name: 'Whitelist',    wl: 'GTD'   },
  { re: /^whitelist$/i,           name: 'Whitelist',    wl: 'GTD'   },
  { re: /^wl$/i,                  name: 'WL',           wl: 'GTD'   },
  { re: /^pre\s*sale$/i,          name: 'Presale',      wl: 'GTD'   },
  { re: /^presale$/i,             name: 'Presale',      wl: 'GTD'   },
  { re: /^fcfs$/i,                name: 'FCFS',         wl: 'FCFS'  },
  { re: /^gtd$/i,                 name: 'GTD',          wl: 'GTD'   },
  { re: /^guaranteed$/i,          name: 'GTD',          wl: 'GTD'   },
  { re: /^team\s+treasury$/i,     name: 'Team Treasury',wl: 'GTD'   },
  { re: /^treasury$/i,            name: 'Treasury',     wl: 'GTD'   },
  { re: /^team$/i,                name: 'Team',         wl: 'GTD'   },
  { re: /^claim$/i,               name: 'Claim',        wl: 'PUBLIC'},
  { re: /^open\s+edition$/i,      name: 'Open Edition', wl: 'PUBLIC'},
  { re: /^holder\s+mint$/i,       name: 'Holder Mint',  wl: 'GTD'  },
  { re: /^holder$/i,              name: 'Holder',       wl: 'GTD'  },
  { re: /^raffle$/i,              name: 'Raffle',       wl: 'RAFFLE'},
  { re: /^og$/i,                  name: 'OG',           wl: 'GTD'  },
  { re: /^vip$/i,                 name: 'VIP',          wl: 'GTD'  },
  { re: /^community$/i,           name: 'Community',    wl: 'GTD'  },
  { re: /^early\s+access$/i,      name: 'Early Access', wl: 'GTD'  },
  { re: /^partner$/i,             name: 'Partner',      wl: 'GTD'  },
  { re: /^waitlist$/i,            name: 'Waitlist',     wl: 'GTD'  },
  { re: /^private\s*sale?$/i,     name: 'Private',      wl: 'GTD'  },
  { re: /^private$/i,             name: 'Private',      wl: 'GTD'  },
]

// ────────────────────────────────────────────────────────────────────────────
// PRICE HELPERS
// ────────────────────────────────────────────────────────────────────────────

function normalizeEthPrice(raw) {
  if (raw == null || raw === '') return null
  const n = Number(String(raw).replace(/[, ]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0) return '0'
  if (n >= 1e15) return (n / 1e18).toFixed(6).replace(/\.?0+$/, '')
  if (n > 1000)  return null
  return n.toString()
}

function parsePriceFromText(text) {
  if (/^free$/i.test(text.trim())) return '0'
  const m = text.match(/([\d,]+\.?\d*)\s*eth/i)
  if (m) return normalizeEthPrice(m[1])
  const m2 = text.match(/^([\d,]+\.?\d*)$/)
  if (m2) return normalizeEthPrice(m2[1])
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// DATE HELPERS
// ────────────────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
}

function parseDateText(text) {
  if (!text) return null
  // ISO 8601
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  if (iso) { const d = new Date(iso[0]); if (!isNaN(d)) return d.toISOString() }

  // "May 20, 2025" or "May 20, 2025, 3:00 PM" or "May 20, 2025 · 3:00 PM"
  const human = text.match(/(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:[,·\s]+(\d{1,2}:\d{2}(?:\s*[AP]M)?))?/i)
  if (human) {
    const mon = MONTH_MAP[human[1].slice(0,3).toLowerCase()]
    if (mon) {
      const dateStr = `${human[3]}-${String(mon).padStart(2,'0')}-${String(human[2]).padStart(2,'0')}T${human[4] || '00:00'}`.replace(/\s*(AM|PM)/i, '')
      const d = new Date(dateStr)
      if (!isNaN(d)) return d.toISOString()
    }
  }

  // Unix timestamp (seconds)
  const unix = text.match(/^(\d{10})$/)
  if (unix) { const d = new Date(Number(unix[1]) * 1000); if (!isNaN(d)) return d.toISOString() }

  return null
}

// ────────────────────────────────────────────────────────────────────────────
// COUNTDOWN PARSER
// ────────────────────────────────────────────────────────────────────────────

function parseCountdownText(text) {
  const d = Number((text.match(/(\d+)\s*d(?:ay)?s?/i) || [])[1] || 0)
  const h = Number((text.match(/(\d+)\s*h(?:our)?s?/i) || [])[1] || 0)
  const m = Number((text.match(/(\d+)\s*m(?:in(?:utes?)?)?/i) || [])[1] || 0)
  const s = Number((text.match(/(\d+)\s*s(?:ec(?:onds?)?)?/i) || [])[1] || 0)
  const ms = ((d * 86400) + (h * 3600) + (m * 60) + s) * 1000
  if (ms <= 0) return null
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m && !d) parts.push(`${m}m`)
  return { ms, text: parts.join(' ') || '< 1m' }
}

// ────────────────────────────────────────────────────────────────────────────
// TEXT-BASED STAGE PARSER
// Parses innerText from a rendered OpenSea page.
// ────────────────────────────────────────────────────────────────────────────

function parseRenderedText(rawText) {
  const lines  = rawText.split('\n').map(l => l.trim()).filter(Boolean)
  const now    = Date.now()
  const stages = []

  // Locate "Mint Schedule" section (optional — narrows search space)
  const schedIdx = lines.findIndex(l => /^mint\s+schedule$/i.test(l))
  const startIdx = schedIdx >= 0 ? schedIdx + 1 : 0

  // Find indices of lines that match stage names
  const stageHits = []
  for (let i = startIdx; i < lines.length; i++) {
    for (const def of STAGE_DEFS) {
      if (def.re.test(lines[i])) {
        stageHits.push({ idx: i, def })
        break
      }
    }
  }

  if (!stageHits.length) return { stages: [], countdown: null, rawScheduleFound: schedIdx >= 0 }

  for (let si = 0; si < stageHits.length; si++) {
    const { idx, def } = stageHits[si]
    const nextIdx = si < stageHits.length - 1
      ? stageHits[si + 1].idx
      : Math.min(idx + 25, lines.length)
    const block = lines.slice(idx + 1, nextIdx)

    // ── Price ──────────────────────────────────────────────────────────────
    let price = null
    for (const line of block) {
      const p = parsePriceFromText(line)
      if (p !== null) { price = p; break }
      // "Price: 0.05 ETH" or "0.05 ETH per mint"
      const labeled = line.match(/price[:\s]+([\d.]+\s*eth|free)/i)
      if (labeled) { price = parsePriceFromText(labeled[1]); break }
    }

    // ── Dates ──────────────────────────────────────────────────────────────
    const dates = []
    for (const line of block) {
      // "May 20, 2025 – May 21, 2025" (em-dash or regular dash)
      const rangeParts = line.split(/\s*[–—-]\s*/)
      for (const part of rangeParts) {
        const d = parseDateText(part)
        if (d && !dates.includes(d)) dates.push(d)
      }
      if (dates.length >= 2) break
    }
    // Single-line "Starts May 20" / "Ends May 20"
    for (const line of block) {
      const startMatch = line.match(/starts?\s+(.+)/i)
      if (startMatch) { const d = parseDateText(startMatch[1]); if (d && !dates[0]) dates[0] = d }
      const endMatch = line.match(/ends?\s+(.+)/i)
      if (endMatch) { const d = parseDateText(endMatch[1]); if (d && !dates[1]) dates[1] = d }
    }

    const startTime = dates[0] || null
    const endTime   = dates[1] || null

    // ── Wallet limit ───────────────────────────────────────────────────────
    let maxWallet = null
    for (const line of block) {
      const m = line.match(/(\d+)\s+per\s+wallet/i)
                || line.match(/limit\s+per\s+wallet[:\s]+(\d+)/i)
                || line.match(/max[:\s]+(\d+)\s+per\s+wallet/i)
                || line.match(/(\d+)\s+max/i)
      if (m) { maxWallet = Number(m[1]); break }
    }

    // ── Status ─────────────────────────────────────────────────────────────
    let status = 'unknown'
    if (startTime) {
      const start = new Date(startTime).getTime()
      const end   = endTime ? new Date(endTime).getTime() : Infinity
      if      (start <= now && now < end) status = 'live_now'
      else if (end   <= now)             status = 'ended'
      else                               status = 'upcoming'
    }
    // Override with explicit text status badge if found
    for (const line of block.slice(0, 4)) {
      if (/\b(live|minting\s+now)\b/i.test(line))  { status = 'live_now';  break }
      if (/\bended\b|\bsold\s+out\b/i.test(line))  { status = 'ended';     break }
      if (/\bupcoming\b|\bscheduled\b/i.test(line)) { status = 'upcoming'; break }
    }

    stages.push({
      name:           def.name,
      status,
      start_time:     startTime,
      end_time:       endTime,
      price,
      token:          'ETH',
      max_per_wallet: maxWallet,
      eligibility:    def.wl !== 'PUBLIC' ? def.wl.toLowerCase() : null,
      wl_type:        def.wl,
      source:         'browser_render',
    })
  }

  return { stages, countdown: null, rawScheduleFound: schedIdx >= 0 }
}

// ────────────────────────────────────────────────────────────────────────────
// BROWSER EXTRACTION
// ────────────────────────────────────────────────────────────────────────────

async function extractFromBrowser(pageUrl) {
  const debugInfo = { steps: [], elapsed_ms: 0 }
  const t0 = Date.now()

  let browser = null
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    })

    const context = await browser.newContext({
      userAgent:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport:     { width: 1280, height: 800 },
      locale:       'en-US',
      timezoneId:   'America/New_York',
    })

    // Block images, fonts, media — speed up loading
    await context.route('**/*', (route, req) => {
      const type = req.resourceType()
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        route.abort()
      } else {
        route.continue()
      }
    })

    const page    = await context.newPage()
    const remaining = Math.max(0, MAX_MS - (Date.now() - t0))

    debugInfo.steps.push('browser_launched')

    // Navigate
    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout:   Math.min(remaining, 10000),
      })
      debugInfo.steps.push('page_loaded')
    } catch (e) {
      debugInfo.steps.push(`page_load_failed:${e.message.slice(0,60)}`)
    }

    // Wait for schedule-related UI or React hydration
    const waitRemaining = Math.max(0, MAX_MS - (Date.now() - t0) - 1000)
    if (waitRemaining > 1000) {
      await Promise.race([
        // Wait for any element containing "Mint Schedule" text
        page.waitForFunction(
          () => document.body.innerText.includes('Mint Schedule') ||
                document.body.innerText.includes('Minting Now') ||
                document.body.innerText.includes('Minting in'),
          { timeout: Math.min(waitRemaining, 5000) }
        ).catch(() => null),
        // Or plain timeout — render whatever loaded
        new Promise(r => setTimeout(r, Math.min(waitRemaining, 3500))),
      ])
      debugInfo.steps.push('schedule_wait_done')
    }

    // Allow React to finish rendering
    await page.waitForTimeout(500)

    // ── Extract data from rendered page ──────────────────────────────────
    const extracted = await page.evaluate(() => {
      const body = document.body

      // innerText gives us all visible text (respects CSS display:none)
      const innerText = body.innerText || ''

      // Try to grab window.__NEXT_DATA__ after hydration — may have richer data
      // than what was in the server HTML
      let nextData = null
      try {
        if (window.__NEXT_DATA__) nextData = window.__NEXT_DATA__
      } catch {}

      // Try Apollo or GraphQL state (OpenSea uses Apollo client)
      let apolloState = null
      try {
        // Apollo stores queries in window.__APOLLO_CLIENT__ or similar
        for (const k of Object.keys(window)) {
          if (k.includes('APOLLO') || k.includes('apollo')) {
            try { apolloState = JSON.parse(JSON.stringify(window[k])) } catch {}
            break
          }
        }
      } catch {}

      // Find mint-schedule related DOM sections for targeted extraction
      // Walk all text nodes for stage-name-like content
      const stageElements = []
      const STAGE_NAMES = [
        'Public Sale','Public','Allowlist','Allow List','Whitelist','WL',
        'Presale','Pre-Sale','FCFS','GTD','Guaranteed','Team Treasury',
        'Claim','Open Edition','Holder Mint','Raffle','OG','VIP',
        'Community','Early Access','Partner','Private',
      ]
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim()
        if (STAGE_NAMES.some(n => t.toLowerCase() === n.toLowerCase())) {
          // Walk up to find container card (~5 levels)
          let el = node.parentElement
          for (let i = 0; i < 6 && el && el !== body; i++) el = el.parentElement
          if (el) {
            stageElements.push({
              stageName: t,
              cardText:  (el.innerText || '').trim().slice(0, 500),
            })
          }
        }
      }

      return {
        innerText:      innerText.slice(0, 60000),
        stageElements:  stageElements.slice(0, 20),
        hasNextData:    Boolean(nextData),
        nextDataJson:   nextData ? JSON.stringify(nextData).slice(0, 80000) : null,
        hasApolloState: Boolean(apolloState),
      }
    })

    debugInfo.steps.push('dom_extracted')
    debugInfo.inner_text_len = extracted.innerText.length
    debugInfo.stage_elements = extracted.stageElements.length
    debugInfo.has_next_data  = extracted.hasNextData

    await browser.close()
    browser = null
    debugInfo.elapsed_ms = Date.now() - t0

    return { extracted, debugInfo }
  } catch (e) {
    debugInfo.steps.push(`error:${e.message.slice(0, 100)}`)
    debugInfo.elapsed_ms = Date.now() - t0
    return { extracted: null, debugInfo, error: e.message }
  } finally {
    if (browser) { try { await browser.close() } catch {} }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// NORMALIZE NEXT_DATA IN BROWSER CONTEXT
// (Same logic as server, adapted for in-browser use)
// ────────────────────────────────────────────────────────────────────────────

function extractStagesFromNextDataJson(jsonStr) {
  if (!jsonStr) return []
  let nd
  try { nd = JSON.parse(jsonStr) } catch { return [] }

  const stages = []

  function recurse(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 14) return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isStageCandidate(item)) stages.push(item)
        else recurse(item, depth + 1)
      }
      return
    }
    for (const key of ['stages','sale_stages','mint_stages','saleStages','phases','drops','mintSchedule','schedule']) {
      if (node[key]) recurse(node[key], depth + 1)
    }
    if (depth > 1 && isStageCandidate(node) && !stages.includes(node)) stages.push(node)
    for (const key of ['drop','collection','initialData','pageProps','props','data','ssrLazyProps','dehydratedState','initialState']) {
      if (node[key] && typeof node[key] === 'object') recurse(node[key], depth + 1)
    }
  }

  function isStageCandidate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
    return !!(
      obj.start_date || obj.start_time ||
      obj.end_date   || obj.end_time   ||
      obj.mint_price != null || obj.price != null || obj.price_per_token != null ||
      obj.allowlist_type || obj.sale_type ||
      (typeof obj.stage === 'string' && obj.stage.length < 60 && obj.stage.trim().length > 0) ||
      obj.stage_name
    )
  }

  recurse(nd)
  return stages
}

// ────────────────────────────────────────────────────────────────────────────
// NORMALIZE STAGE FROM RAW CANDIDATE (drops API / next_data)
// ────────────────────────────────────────────────────────────────────────────

function STAGE_NAME_MAP(raw) {
  const MAP = {
    public:'Public', allowlist:'Allowlist', allow_list:'Allowlist',
    whitelist:'Whitelist', presale:'Presale', fcfs:'FCFS',
    gtd:'GTD', guaranteed:'GTD', open_edition:'Open Edition',
    openedition:'Open Edition', claim:'Claim', raffle:'Raffle',
    team_treasury:'Team Treasury', holder_mint:'Holder Mint',
  }
  const s = String(raw||'').toLowerCase().trim().replace(/[\s-]+/g,'_')
  return MAP[s] || (raw ? raw.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : null)
}

function WL_TYPE(raw) {
  const s = String(raw||'').toLowerCase()
  if (s.includes('gtd')||s.includes('guaranteed')) return 'GTD'
  if (s.includes('fcfs'))                           return 'FCFS'
  if (s.includes('raffle'))                         return 'RAFFLE'
  if (s.includes('allow')||s.includes('whitelist')||s==='wl'||s.includes('presale')) return 'GTD'
  if (s.includes('public')||s.includes('open')||s.includes('claim'))   return 'PUBLIC'
  return 'UNKNOWN'
}

function normalizeRawStage(s, token = 'ETH') {
  const rawName  = s.stage || s.stage_name || s.name || s.phase || null
  const startRaw = s.start_date || s.start_time || null
  const endRaw   = s.end_date   || s.end_time   || null
  const now      = Date.now()

  // Try all price fields
  const priceCandidates = [
    s.mint_price, s.price, s.price_per_token, s.native_price,
    s.display_price, s.sale_config?.publicSalePrice, s.sale_config?.price,
    s.payment_token?.eth_price,
  ]
  let price = null
  for (const raw of priceCandidates) {
    const v = normalizeEthPrice(raw)
    if (v !== null) { price = v; break }
  }
  // Inherited drop price
  if (price === null && s._drop_price != null) price = normalizeEthPrice(s._drop_price)

  let status = 'unknown'
  if (startRaw) {
    const start = new Date(startRaw).getTime()
    if (!isNaN(start)) {
      const end = endRaw ? new Date(endRaw).getTime() : Infinity
      if      (start <= now && now < end) status = 'live_now'
      else if (end   <= now)             status = 'ended'
      else                               status = 'upcoming'
    }
  }

  return {
    name:           STAGE_NAME_MAP(rawName),
    status,
    start_time:     startRaw,
    end_time:       endRaw,
    price,
    token,
    max_per_wallet: s.max_per_wallet ?? s._drop_max ?? null,
    eligibility:    s.allowlist_type || s.sale_type || null,
    wl_type:        WL_TYPE(rawName || s.allowlist_type || ''),
    source:         'browser_next_data',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MERGE AND COMPUTE FINAL RESULT
// ────────────────────────────────────────────────────────────────────────────

function buildResult(stages) {
  if (!stages.length) {
    return {
      schedule_exposed:          false,
      stages:                    [],
      mint_status:               null,
      mint_date:                 null,
      end_date:                  null,
      mint_price:                null,
      countdown_text:            null,
      has_wl_phase:              false,
      max_per_wallet:            null,
      current_stage:             null,
      next_stage:                null,
      needs_manual_confirmation: true,
    }
  }

  const now      = Date.now()
  const ORDER    = { live_now: 0, upcoming: 1, ended: 2, unknown: 3 }
  const sorted   = [...stages].sort((a, b) => {
    const od = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
    if (od) return od
    if (!a.start_time && !b.start_time) return 0
    if (!a.start_time) return 1
    if (!b.start_time) return -1
    return new Date(a.start_time) - new Date(b.start_time)
  })

  const live    = sorted.filter(s => s.status === 'live_now')
  const upcoming = sorted.filter(s => s.status === 'upcoming')
  const ended   = sorted.filter(s => s.status === 'ended')
  const current = live[0]     || null
  const next    = upcoming[0] || null
  const primary = current || next || sorted[0]

  const mintStatus =
    current                           ? 'live_now'
    : next                            ? 'upcoming'
    : ended.length === sorted.length  ? 'ended'
    : 'needs_review'

  const hasWl = sorted.some(s => ['GTD','FCFS','RAFFLE'].includes(s.wl_type))

  // Countdown from real timestamp
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

  return {
    schedule_exposed:          true,
    stages:                    sorted,
    mint_status:               mintStatus,
    mint_date:                 primary?.start_time || null,
    end_date:                  primary?.end_time   || null,
    mint_price:                primary?.price      || null,
    countdown_text:            countdownText,
    has_wl_phase:              hasWl,
    max_per_wallet:            primary?.max_per_wallet || null,
    current_stage:             current?.name || null,
    next_stage:                next?.name    || null,
    needs_manual_confirmation: false,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN EXTRACT HANDLER
// ────────────────────────────────────────────────────────────────────────────

async function handleExtract(pageUrl) {
  // Run browser extraction with overall timeout
  const timeoutPromise = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('extraction_timeout')), MAX_MS + 2000)
  )

  let browserResult
  try {
    browserResult = await Promise.race([extractFromBrowser(pageUrl), timeoutPromise])
  } catch (e) {
    return {
      ...buildResult([]),
      error:                   e.message,
      needs_manual_confirmation: true,
      debug: { error: e.message },
    }
  }

  const { extracted, debugInfo, error } = browserResult
  if (!extracted) {
    return {
      ...buildResult([]),
      error,
      needs_manual_confirmation: true,
      debug: debugInfo,
    }
  }

  const allStages = []
  const dedupeKey = new Set()

  function addStage(s) {
    const fp = `${s.start_time}|${s.end_time}|${s.price}|${s.name}`
    if (dedupeKey.has(fp)) return
    dedupeKey.add(fp)
    // Only accept stages with at least one strong signal
    if (!s.name && !s.start_time && s.price == null && !s.wl_type) return
    allStages.push(s)
  }

  // ── Source A: __NEXT_DATA__ from browser (may differ from server HTML) ──
  if (extracted.nextDataJson) {
    const rawStages = extractStagesFromNextDataJson(extracted.nextDataJson)
    for (const raw of rawStages) {
      addStage(normalizeRawStage(raw))
    }
    if (rawStages.length) debugInfo.steps.push(`next_data_stages:${rawStages.length}`)
  }

  // ── Source B: DOM card text (targeted — most reliable for visible data) ──
  if (extracted.stageElements.length) {
    for (const { stageName, cardText } of extracted.stageElements) {
      const def = STAGE_DEFS.find(d => d.re.test(stageName.trim())) || { name: stageName, wl: 'UNKNOWN' }
      const parsed = parseRenderedText(def.name + '\n' + cardText)
      for (const s of parsed.stages) addStage({ ...s, name: def.name, wl_type: def.wl })
    }
    debugInfo.steps.push(`dom_card_stages:${extracted.stageElements.length}`)
  }

  // ── Source C: Full innerText parse (broadest fallback) ──────────────────
  if (!allStages.length && extracted.innerText) {
    const parsed = parseRenderedText(extracted.innerText)
    for (const s of parsed.stages) addStage(s)
    if (parsed.stages.length) debugInfo.steps.push(`innertext_stages:${parsed.stages.length}`)

    // Countdown fallback when no stages found
    if (!allStages.length) {
      const cd = parsed.countdown || (() => {
        const m = extracted.innerText.match(/minting\s+in\b[\s\S]{0,200}/i)
        return m ? parseCountdownText(m[0]) : null
      })()
      if (cd) {
        const approxStart = new Date(Date.now() + cd.ms).toISOString()
        return {
          ...buildResult([]),
          schedule_exposed:          false,
          mint_status:               'upcoming',
          mint_date:                 approxStart,
          countdown_text:            cd.text,
          needs_manual_confirmation: true,
          debug: { ...debugInfo, final_reason: 'text_countdown' },
        }
      }
    }
  }

  const result = buildResult(allStages)
  return { ...result, debug: { ...debugInfo, stages_found: allStages.length } }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP SERVER
// ────────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((res, rej) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 4096) rej(new Error('body_too_large')) })
    req.on('end', () => {
      try { res(JSON.parse(data)) } catch { res({}) }
    })
    req.on('error', rej)
  })
}

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(json)
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`)

  // Health check
  if (parsed.pathname === '/health') {
    return send(res, 200, { ok: true, ts: Date.now() })
  }

  if (parsed.pathname !== '/extract') {
    return send(res, 404, { error: 'not_found' })
  }

  // Optional secret check
  if (SECRET) {
    const authHeader = req.headers['x-extractor-secret'] || req.headers['authorization']?.replace('Bearer ', '')
    if (authHeader !== SECRET) {
      return send(res, 401, { error: 'unauthorized' })
    }
  }

  let pageUrl = parsed.searchParams.get('url') || ''

  // For POST requests, also try body
  if ((req.method === 'POST' || req.method === 'PUT') && !pageUrl) {
    try {
      const body = await readBody(req)
      pageUrl = body.url || ''
    } catch {
      return send(res, 400, { error: 'invalid_body' })
    }
  }

  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
    return send(res, 400, { error: 'url_required', detail: 'Provide ?url= or POST { url }' })
  }

  // Only OpenSea URLs accepted
  if (!/opensea\.io\//i.test(pageUrl)) {
    return send(res, 400, { error: 'unsupported_url', detail: 'Only opensea.io URLs are supported' })
  }

  console.log(`[extractor] ${req.method} extract url=${pageUrl}`)

  try {
    const result = await handleExtract(pageUrl)
    console.log(`[extractor] done stages=${result.stages?.length ?? 0} status=${result.mint_status}`)
    return send(res, 200, result)
  } catch (e) {
    console.error('[extractor] unhandled error:', e.message)
    return send(res, 500, {
      error:                     'extraction_failed',
      detail:                    e.message,
      schedule_exposed:          false,
      needs_manual_confirmation: true,
    })
  }
})

server.listen(PORT, () => {
  console.log(`[extractor] OpenSea render extractor listening on port ${PORT}`)
  console.log(`[extractor] secret=${SECRET ? 'set' : 'none'} timeout=${MAX_MS}ms`)
})

process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
process.on('SIGINT',  () => { server.close(() => process.exit(0)) })
