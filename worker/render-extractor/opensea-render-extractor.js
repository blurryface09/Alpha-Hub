/**
 * worker/render-extractor/opensea-render-extractor.js
 *
 * Railway HTTP service — Playwright browser-render extractor for OpenSea.
 *
 * Problem: OpenSea renders mint schedule (stages, prices, times, limits) via
 * client-side React. Server HTML and the drops API often omit this data.
 * This service opens the URL in a real Chromium browser, waits for the schedule
 * to render, and extracts structured stage data.
 *
 * GET /extract?url=<opensea_url>          — extract stages
 * GET /extract?url=<opensea_url>&debug=1  — also include page_url, title, body_text_sample, etc.
 * GET /health
 *
 * Returns: { schedule_exposed, stages[], mint_status, mint_date, end_date,
 *            mint_price, countdown_text, has_wl_phase, max_per_wallet,
 *            current_stage, next_stage, needs_manual_confirmation,
 *            blocked_or_bot_detected, failure_reason, debug{} }
 */

import { chromium as chromiumExtra } from 'playwright-extra'
import StealthPlugin                 from 'puppeteer-extra-plugin-stealth'
import http                          from 'http'
import { URL }                       from 'url'

// Register stealth plugin — patches navigator.webdriver, chrome runtime,
// permissions, plugins, etc. Must be called before first launch().
chromiumExtra.use(StealthPlugin())

const PORT            = Number(process.env.PORT || 3001)
const SECRET          = process.env.RENDER_EXTRACTOR_SECRET || ''
const MAX_MS          = Number(process.env.EXTRACTOR_TIMEOUT_MS || 30000)
const PROXY_SERVER    = process.env.PROXY_SERVER    || ''
const PROXY_USERNAME  = process.env.PROXY_USERNAME  || ''
const PROXY_PASSWORD  = process.env.PROXY_PASSWORD  || ''

// Realistic Chrome 124 stable UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.155 Safari/537.36'

// ────────────────────────────────────────────────────────────────────────────
// STEALTH INIT SCRIPT
// Injected into every page before any JS executes.
// Belt-and-suspenders on top of playwright-extra-plugin-stealth.
// ────────────────────────────────────────────────────────────────────────────

const STEALTH_SCRIPT = `(function () {
  // 1. navigator.webdriver → false
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }) } catch {}

  // 2. window.chrome (required by many bot-detection scripts)
  try {
    if (!window.chrome) window.chrome = {}
    if (!window.chrome.runtime) window.chrome.runtime = {}
    if (!window.chrome.app)     window.chrome.app     = { isInstalled: false, getDetails: function(){}, getIsInstalled: function(){}, installState: function(){} }
    if (!window.chrome.csi)     window.chrome.csi     = function () {}
    if (!window.chrome.loadTimes) window.chrome.loadTimes = function () { return {} }
  } catch {}

  // 3. navigator.languages
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true }) } catch {}

  // 4. navigator.plugins (fake three common Chrome plugins)
  try {
    const fakePlugins = [
      { name: 'Chrome PDF Plugin',   filename: 'internal-pdf-viewer',               description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer',   filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',  description: '' },
      { name: 'Native Client',       filename: 'internal-nacl-plugin',              description: '' },
    ]
    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins, configurable: true })
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [], configurable: true })
  } catch {}

  // 5. Hardware profile
  try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8,  configurable: true }) } catch {}
  try { Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8,  configurable: true }) } catch {}
  try { Object.defineProperty(navigator, 'platform',            { get: () => 'Win32', configurable: true }) } catch {}

  // 6. permissions.query — spoof notification permission
  try {
    const origQuery = window.navigator.permissions.query.bind(navigator.permissions)
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery(params)
  } catch {}

  // 7. Erase CDP / Playwright artefacts
  try { delete window.__playwright } catch {}
  try { delete window.__pw_manual  } catch {}
  try { delete window._phantom     } catch {}
  try { delete window.callPhantom  } catch {}

  // 8. Overwrite Notification.permission so it's not 'denied' (default in headless)
  try { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }) } catch {}

  // 9. Screen dimensions consistent with 1280×900 viewport
  try { Object.defineProperty(screen, 'availWidth',  { get: () => 1280, configurable: true }) } catch {}
  try { Object.defineProperty(screen, 'availHeight', { get: () => 900,  configurable: true }) } catch {}
  try { Object.defineProperty(screen, 'width',       { get: () => 1280, configurable: true }) } catch {}
  try { Object.defineProperty(screen, 'height',      { get: () => 900,  configurable: true }) } catch {}
})();`

// ────────────────────────────────────────────────────────────────────────────
// STAGE DEFINITIONS
// More permissive than before — allow common OpenSea variations.
// Tested in order; first match wins.
// ────────────────────────────────────────────────────────────────────────────

const STAGE_DEFS = [
  { re: /^public\s+sale$/i,          name: 'Public Sale',     wl: 'PUBLIC' },
  { re: /^public\s+stage$/i,         name: 'Public',          wl: 'PUBLIC' },
  { re: /^public\s+mint$/i,          name: 'Public',          wl: 'PUBLIC' },
  { re: /^public$/i,                 name: 'Public',          wl: 'PUBLIC' },
  { re: /^allowlist\s+sale$/i,       name: 'Allowlist Sale',  wl: 'GTD'   },
  { re: /^allowlist\s+stage$/i,      name: 'Allowlist',       wl: 'GTD'   },
  { re: /^allow\s*list\s*sale$/i,    name: 'Allowlist Sale',  wl: 'GTD'   },
  { re: /^allow\s*list\s*stage$/i,   name: 'Allowlist',       wl: 'GTD'   },
  { re: /^allow\s*list$/i,           name: 'Allowlist',       wl: 'GTD'   },
  { re: /^allowlist$/i,              name: 'Allowlist',       wl: 'GTD'   },
  { re: /^whitelist\s+sale$/i,       name: 'Whitelist Sale',  wl: 'GTD'   },
  { re: /^white\s*list$/i,           name: 'Whitelist',       wl: 'GTD'   },
  { re: /^whitelist$/i,              name: 'Whitelist',       wl: 'GTD'   },
  { re: /^wl\s+sale$/i,              name: 'WL Sale',         wl: 'GTD'   },
  { re: /^wl$/i,                     name: 'WL',              wl: 'GTD'   },
  { re: /^pre\s*sale$/i,             name: 'Presale',         wl: 'GTD'   },
  { re: /^presale$/i,                name: 'Presale',         wl: 'GTD'   },
  { re: /^fcfs$/i,                   name: 'FCFS',            wl: 'FCFS'  },
  { re: /^gtd$/i,                    name: 'GTD',             wl: 'GTD'   },
  { re: /^guaranteed$/i,             name: 'GTD',             wl: 'GTD'   },
  { re: /^team\s+treasury$/i,        name: 'Team Treasury',   wl: 'GTD'   },
  { re: /^treasury$/i,               name: 'Treasury',        wl: 'GTD'   },
  { re: /^team$/i,                   name: 'Team',            wl: 'GTD'   },
  { re: /^claim$/i,                  name: 'Claim',           wl: 'PUBLIC'},
  { re: /^open\s+edition$/i,         name: 'Open Edition',    wl: 'PUBLIC'},
  { re: /^holder\s+mint$/i,          name: 'Holder Mint',     wl: 'GTD'  },
  { re: /^holder\s+stage$/i,         name: 'Holder',          wl: 'GTD'  },
  { re: /^holder$/i,                 name: 'Holder',          wl: 'GTD'  },
  { re: /^raffle$/i,                 name: 'Raffle',          wl: 'RAFFLE'},
  { re: /^og\s+mint$/i,              name: 'OG',              wl: 'GTD'  },
  { re: /^og$/i,                     name: 'OG',              wl: 'GTD'  },
  { re: /^vip$/i,                    name: 'VIP',             wl: 'GTD'  },
  { re: /^community\s+mint$/i,       name: 'Community',       wl: 'GTD'  },
  { re: /^community$/i,              name: 'Community',       wl: 'GTD'  },
  { re: /^early\s+access$/i,         name: 'Early Access',    wl: 'GTD'  },
  { re: /^partner$/i,                name: 'Partner',         wl: 'GTD'  },
  { re: /^waitlist$/i,               name: 'Waitlist',        wl: 'GTD'  },
  { re: /^private\s+sale?$/i,        name: 'Private',         wl: 'GTD'  },
  { re: /^private$/i,                name: 'Private',         wl: 'GTD'  },
  // Numbered phases — name is taken from the raw line
  { re: /^phase\s+\d+$/i,            name: null,              wl: 'UNKNOWN'},
  { re: /^stage\s+\d+$/i,            name: null,              wl: 'UNKNOWN'},
  { re: /^round\s+\d+$/i,            name: null,              wl: 'UNKNOWN'},
]

// Keywords to wait for in browser before parsing
const WAIT_KEYWORDS = [
  'Mint Schedule', 'Mint schedule', 'Public Stage', 'Public Sale', 'Allowlist',
  'per wallet', ' ETH', 'Starts', 'Ends', 'Limit',
]

// Bot/blocked detection patterns
const BOT_PATTERNS = /cloudflare|access denied|enable javascript|captcha|i'm not a robot|checking your browser|please wait|just a moment|ddos|firewall|blocked|403 forbidden/i

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

function parsePriceFromLine(line) {
  const t = line.trim()
  if (/^free$/i.test(t)) return '0'
  // "0.05 ETH" / ".05ETH" / "0.05 eth"
  const m = t.match(/([\d]*\.?\d+)\s*eth\b/i)
  if (m) return normalizeEthPrice(m[1])
  // Bare numeric that looks like a price (0.001 – 100)
  const m2 = t.match(/^([\d]*\.[\d]+)$/)
  if (m2) {
    const v = Number(m2[1])
    if (v >= 0 && v <= 100) return normalizeEthPrice(m2[1])
  }
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
  const t = text.trim()

  // ISO 8601: 2025-05-20T15:00
  const iso = t.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  if (iso) { const d = new Date(iso[0]); if (!isNaN(d)) return d.toISOString() }

  // "May 20, 2025" or "May 20, 2025, 3:00 PM" or "May 20, 2025 · 3:00 PM UTC"
  const human = t.match(/(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:[,·\s]+(\d{1,2}:\d{2})(?:\s*([AP]M))?)?/i)
  if (human) {
    const mon = MONTH_MAP[human[1].slice(0, 3).toLowerCase()]
    if (mon) {
      let timeStr = human[4] || '00:00'
      if (human[5]) {
        let [hh, mm] = timeStr.split(':').map(Number)
        if (human[5].toUpperCase() === 'PM' && hh < 12) hh += 12
        if (human[5].toUpperCase() === 'AM' && hh === 12) hh = 0
        timeStr = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`
      }
      const dateStr = `${human[3]}-${String(mon).padStart(2,'0')}-${String(human[2]).padStart(2,'0')}T${timeStr}`
      const d = new Date(dateStr)
      if (!isNaN(d)) return d.toISOString()
    }
  }

  // Unix timestamp (10-digit seconds)
  const unix = t.match(/^(\d{10})$/)
  if (unix) { const d = new Date(Number(unix[1]) * 1000); if (!isNaN(d)) return d.toISOString() }

  return null
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE NAME MATCHER
// ────────────────────────────────────────────────────────────────────────────

function matchStageDef(line) {
  const t = line.trim()
  if (!t || t.length > 60) return null
  for (const def of STAGE_DEFS) {
    if (def.re.test(t)) return { name: def.name || t, wl: def.wl }
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE BLOCK PARSER
// Given a label + a slice of lines immediately below it, extract stage data.
// ────────────────────────────────────────────────────────────────────────────

function extractStageFromBlock(stageName, wlType, blockLines) {
  const now    = Date.now()
  let price    = null
  let startTime = null
  let endTime   = null
  let maxWallet = null
  let status   = 'unknown'

  for (const line of blockLines) {
    const t = line.trim()
    if (!t) continue

    // ── Price ──────────────────────────────────────────────────────────────
    if (price === null) {
      const p = parsePriceFromLine(t)
      if (p !== null) { price = p; continue }
      // "Price: 0.05 ETH"
      const lm = t.match(/price[:\s]+([\d.]+\s*eth|free)/i)
      if (lm) { const p2 = parsePriceFromLine(lm[1]); if (p2 !== null) price = p2 }
    }

    // ── Date range "May 20 – May 21, 2025" (em dash / en dash / hyphen) ──
    if (!startTime) {
      const rangeParts = t.split(/\s*[–—]\s*/)
      if (rangeParts.length >= 2) {
        const d1 = parseDateText(rangeParts[0])
        const d2 = parseDateText(rangeParts[1])
        if (d1) startTime = d1
        if (d2) endTime   = d2
        if (d1 || d2) continue
      }
    }

    // ── "Starts" / "Ends" lines ────────────────────────────────────────────
    const startM = t.match(/starts?\s+(.+)/i)
    if (startM && !startTime) { const d = parseDateText(startM[1]); if (d) startTime = d }
    const endM = t.match(/ends?\s+(.+)/i)
    if (endM && !endTime) { const d = parseDateText(endM[1]); if (d) endTime = d }

    // ── Solo date (only if no other date yet) ─────────────────────────────
    if (!startTime && !startM && !endM) {
      const d = parseDateText(t)
      if (d) startTime = d
    }

    // ── Wallet limit ───────────────────────────────────────────────────────
    if (maxWallet === null) {
      const wm = t.match(/(\d+)\s+per\s+wallet/i)
               || t.match(/limit[:\s]+(\d+)/i)
               || t.match(/max(?:imum)?[:\s]+(\d+)\s+(?:per\s+wallet|nft)/i)
      if (wm) maxWallet = Number(wm[1])
    }

    // ── Status text badge ─────────────────────────────────────────────────
    if (/\b(live|minting\s+now|sale\s+live)\b/i.test(t))    status = 'live_now'
    if (/\bended\b|\bsold\s+out\b|\bclosed\b/i.test(t))     status = 'ended'
    if (/\bupcoming\b|\bscheduled\b|\bnot\s+started\b/i.test(t)) status = 'upcoming'
  }

  // ── Compute status from timestamps when not overridden by badge ────────
  if (status === 'unknown' && startTime) {
    const start = new Date(startTime).getTime()
    const end   = endTime ? new Date(endTime).getTime() : Infinity
    if      (!isNaN(start) && start <= now && now < end) status = 'live_now'
    else if (!isNaN(end)   && end   <= now)              status = 'ended'
    else if (!isNaN(start))                              status = 'upcoming'
  }

  const wl = wlType === 'UNKNOWN' ? guessWlType(stageName) : wlType

  return {
    name:           stageName,
    status,
    start_time:     startTime,
    end_time:       endTime,
    price,
    token:          'ETH',
    max_per_wallet: maxWallet,
    eligibility:    wl !== 'PUBLIC' ? wl.toLowerCase() : null,
    wl_type:        wl,
    source:         'browser_render',
  }
}

function guessWlType(name) {
  const s = String(name || '').toLowerCase()
  if (s.includes('fcfs'))                              return 'FCFS'
  if (s.includes('raffle'))                            return 'RAFFLE'
  if (s.includes('gtd') || s.includes('guaranteed'))  return 'GTD'
  if (s.includes('allow') || s.includes('white') || s.includes('wl') || s.includes('presale')) return 'GTD'
  if (s.includes('public') || s.includes('open') || s.includes('claim')) return 'PUBLIC'
  return 'UNKNOWN'
}

// ────────────────────────────────────────────────────────────────────────────
// FULL TEXT PARSER
// Two-pass approach:
//   Pass 1 — stage-name anchors: find known stage labels, parse block below
//   Pass 2 — price anchors: find ETH lines, look backward for stage name
// Both passes operate on the "Mint Schedule" section when found.
// ────────────────────────────────────────────────────────────────────────────

function parseRenderedText(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean)

  // Find "Mint Schedule" section header
  const schedIdx = lines.findIndex(l => /\bmint\s+schedule\b/i.test(l))
  const workLines = schedIdx >= 0
    ? lines.slice(schedIdx + 1, schedIdx + 250)
    : lines.slice(0, 500) // scan first 500 lines when no header

  const stages    = []
  const usedIdxs  = new Set()

  // ── Pass 1: Stage-name anchors ──────────────────────────────────────────
  const nameHits = []
  for (let i = 0; i < workLines.length; i++) {
    const def = matchStageDef(workLines[i])
    if (def) nameHits.push({ i, def })
  }

  for (let ni = 0; ni < nameHits.length; ni++) {
    const { i: startI, def } = nameHits[ni]
    const endI = ni < nameHits.length - 1
      ? nameHits[ni + 1].i
      : Math.min(startI + 25, workLines.length)

    const blockLines = workLines.slice(startI + 1, endI)
    const stage = extractStageFromBlock(def.name, def.wl, blockLines)

    // Only accept stage if it has at least one real data point
    if (stage.price !== null || stage.start_time || stage.max_per_wallet) {
      stages.push(stage)
      for (let j = startI; j < endI; j++) usedIdxs.add(j)
    }
  }

  // ── Pass 2: Price anchors (finds stages when name isn't a known label) ──
  if (stages.length === 0) {
    for (let i = 0; i < workLines.length; i++) {
      if (usedIdxs.has(i)) continue
      const price = parsePriceFromLine(workLines[i])
      if (price === null) continue

      // Look back up to 5 lines for a stage name
      let stageName = 'Unknown'
      let wlType    = 'UNKNOWN'
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (usedIdxs.has(j)) break
        const def = matchStageDef(workLines[j])
        if (def) { stageName = def.name; wlType = def.wl; break }
        // Short non-price/non-date/non-status line → treat as stage name
        const l = workLines[j].trim()
        if (
          l.length > 0 && l.length <= 50 &&
          parsePriceFromLine(l) === null &&
          parseDateText(l) === null &&
          !/\b(upcoming|live|ended|sold\s+out|minting)\b/i.test(l) &&
          !/^\d+$/.test(l)
        ) {
          stageName = l
          wlType    = guessWlType(l)
          break
        }
      }

      // Forward extent: until next price line or max 12 lines
      let endI = Math.min(i + 12, workLines.length)
      for (let j = i + 1; j < endI; j++) {
        if (!usedIdxs.has(j) && parsePriceFromLine(workLines[j]) !== null) {
          endI = j; break
        }
      }

      const blockLines = workLines.slice(i, endI)
      const stage = extractStageFromBlock(stageName, wlType, blockLines)
      stage.price = stage.price ?? price // anchor price if block parse missed it

      if (stage.price !== null || stage.start_time) {
        stages.push(stage)
        for (let j = i; j < endI; j++) usedIdxs.add(j)
      }
    }
  }

  return { stages, rawScheduleFound: schedIdx >= 0 }
}

// ────────────────────────────────────────────────────────────────────────────
// NEXT_DATA JSON EXTRACTOR (server-side, after browser returns JSON string)
// ────────────────────────────────────────────────────────────────────────────

function extractStagesFromNextDataJson(jsonStr) {
  if (!jsonStr) return []
  let nd
  try { nd = JSON.parse(jsonStr) } catch { return [] }

  const stages = []

  function isStageCandidate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
    return !!(
      obj.start_date || obj.start_time || obj.end_date || obj.end_time ||
      obj.mint_price != null || obj.price != null || obj.price_per_token != null ||
      obj.allowlist_type || obj.sale_type ||
      (typeof obj.stage === 'string' && obj.stage.trim().length > 0 && obj.stage.length < 60) ||
      obj.stage_name
    )
  }

  function recurse(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 16) return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isStageCandidate(item)) stages.push(item)
        else recurse(item, depth + 1)
      }
      return
    }
    // High-priority stage list keys — recurse first
    for (const k of ['stages','sale_stages','mint_stages','saleStages','phases','drops','mintSchedule','schedule','mint_schedule']) {
      if (node[k]) { recurse(node[k], depth + 1) }
    }
    if (depth > 1 && isStageCandidate(node)) stages.push(node)
    // Container keys
    for (const k of ['drop','collection','initialData','pageProps','props','data','event',
                     'ssrLazyProps','dehydratedState','initialState','serverSideProps','queries']) {
      if (node[k] && typeof node[k] === 'object') recurse(node[k], depth + 1)
    }
  }

  recurse(nd)
  // Deduplicate by JSON fingerprint
  const seen = new Set()
  return stages.filter(s => {
    const k = JSON.stringify(s).slice(0, 200)
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}

// ────────────────────────────────────────────────────────────────────────────
// NORMALIZE RAW STAGE (from __NEXT_DATA__ candidates)
// ────────────────────────────────────────────────────────────────────────────

const STAGE_NAME_MAP_TABLE = {
  public:'Public', allowlist:'Allowlist', allow_list:'Allowlist',
  whitelist:'Whitelist', presale:'Presale', pre_sale:'Presale',
  fcfs:'FCFS', gtd:'GTD', guaranteed:'GTD', open_edition:'Open Edition',
  openedition:'Open Edition', claim:'Claim', raffle:'Raffle',
  team_treasury:'Team Treasury', holder_mint:'Holder Mint',
  holder:'Holder', og:'OG', vip:'VIP', community:'Community',
  early_access:'Early Access', partner:'Partner', waitlist:'Waitlist',
  private:'Private',
}

function mapStageName(raw) {
  if (!raw) return null
  const key = String(raw).toLowerCase().trim().replace(/[\s-]+/g,'_')
  return STAGE_NAME_MAP_TABLE[key] || String(raw).replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())
}

function normalizeRawStage(s, token = 'ETH') {
  const rawName  = s.stage || s.stage_name || s.name || s.phase || null
  const startRaw = s.start_date || s.start_time || null
  const endRaw   = s.end_date   || s.end_time   || null
  const now      = Date.now()

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
    name:           mapStageName(rawName),
    status,
    start_time:     startRaw,
    end_time:       endRaw,
    price,
    token,
    max_per_wallet: s.max_per_wallet ?? null,
    eligibility:    s.allowlist_type || s.sale_type || null,
    wl_type:        guessWlType(rawName || s.allowlist_type || ''),
    source:         'browser_next_data',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ANTI-BOT HELPERS
// ────────────────────────────────────────────────────────────────────────────

/** Random integer in [base, base+range) */
function jitter(base, range) {
  return base + Math.floor(Math.random() * range)
}

/** Human-like mouse wiggle across the page */
async function humanMouseMove(page) {
  try {
    const moves = jitter(3, 4)
    for (let i = 0; i < moves; i++) {
      await page.mouse.move(jitter(200, 900), jitter(150, 500), { steps: jitter(8, 15) })
      await page.waitForTimeout(jitter(60, 140))
    }
  } catch {}
}

/** Gradual scroll down then back to top */
async function humanScroll(page) {
  try {
    const bodyH = await page.evaluate(() => document.body.scrollHeight).catch(() => 3000)
    const steps = jitter(4, 3) // 4–6 steps
    for (let i = 1; i <= steps; i++) {
      const y = Math.floor(bodyH * i / steps)
      await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'smooth' }), y)
      await page.waitForTimeout(jitter(350, 500))
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
    await page.waitForTimeout(jitter(250, 350))
  } catch {}
}

/**
 * After a Cloudflare challenge page is detected, poll every second until the
 * challenge clears (title/body no longer match BOT_PATTERNS) or timeout.
 * Returns { resolved, waitMs }.
 */
async function waitForCloudflareClear(page, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1000)
    const { title, bodySnippet } = await page.evaluate(() => ({
      title:       document.title || '',
      bodySnippet: document.body?.innerText?.slice(0, 400) || '',
    })).catch(() => ({ title: '', bodySnippet: '' }))
    if (!BOT_PATTERNS.test(title + ' ' + bodySnippet)) {
      return { resolved: true, waitMs: Date.now() - start }
    }
  }
  return { resolved: false, waitMs: timeoutMs }
}

// ────────────────────────────────────────────────────────────────────────────
// BROWSER EXTRACTION
// ────────────────────────────────────────────────────────────────────────────

async function extractFromBrowser(pageUrl, debugMode = false) {
  const info = {
    steps:                   [],
    elapsed_ms:              0,
    page_url:                pageUrl,
    final_url:               null,
    title:                   null,
    body_text_sample:        null,
    selectors_found:         {},
    iframe_count:            0,
    blocked_or_bot_detected: false,
    cloudflare_resolved:     false,
    challenge_wait_ms:       0,
    ua_used:                 UA,
    schedule_text_found:     false,
    mint_keywords_found:     [],
    screenshot_captured:     false,
    inner_text_len:          0,
    stage_elements:          0,
    has_next_data:           false,
  }
  const t0 = Date.now()

  let browser = null
  try {
    // ── Launch with stealth + anti-detection flags ────────────────────────
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,900',
        '--lang=en-US',
        '--accept-lang=en-US,en;q=0.9',
      ],
    }

    if (PROXY_SERVER) {
      launchOptions.proxy = {
        server:   PROXY_SERVER,
        username: PROXY_USERNAME || undefined,
        password: PROXY_PASSWORD || undefined,
      }
      info.steps.push(`proxy:${PROXY_SERVER.replace(/\/\/.*@/, '//')}`)
    }

    browser = await chromiumExtra.launch(launchOptions)

    const contextOptions = {
      userAgent:   UA,
      viewport:    { width: 1280, height: 900 },
      locale:      'en-US',
      timezoneId:  'America/New_York',
      colorScheme: 'dark',
      extraHTTPHeaders: {
        'sec-ch-ua':          '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile':   '?0',
        'sec-ch-ua-platform': '"Windows"',
        'accept-language':    'en-US,en;q=0.9',
      },
    }

    const context = await browser.newContext(contextOptions)

    // Belt-and-suspenders stealth init script (runs before any page JS)
    await context.addInitScript(STEALTH_SCRIPT)

    // Block only heavy non-essential assets — allow scripts, XHR, fetch
    await context.route('**/*', (route, req) => {
      const type = req.resourceType()
      if (['image', 'media', 'font'].includes(type)) route.abort()
      else route.continue()
    })

    const page = await context.newPage()
    info.steps.push('browser_launched')

    // ── Phase 1: Navigate ─────────────────────────────────────────────────
    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout:   Math.min(MAX_MS * 0.45, 12000),
      })
      info.steps.push('page_load:domcontentloaded')
    } catch (e) {
      info.steps.push(`page_load:error:${String(e.message).slice(0, 60)}`)
    }

    // ── Phase 2: Random pre-interaction delay (feels human) ───────────────
    await page.waitForTimeout(jitter(600, 800))

    // ── Phase 3: Detect Cloudflare challenge and wait for it to clear ─────
    const earlyCheck = await page.evaluate(() => ({
      title:  document.title || '',
      body:   document.body?.innerText?.slice(0, 300) || '',
    })).catch(() => ({ title: '', body: '' }))

    if (BOT_PATTERNS.test(earlyCheck.title + ' ' + earlyCheck.body)) {
      info.steps.push('cloudflare_challenge_detected')
      info.blocked_or_bot_detected = true
      // Move mouse realistically while waiting
      await humanMouseMove(page)
      const cfWait = await waitForCloudflareClear(page, 20000)
      info.cloudflare_resolved = cfWait.resolved
      info.challenge_wait_ms   = cfWait.waitMs
      if (cfWait.resolved) {
        info.steps.push(`cloudflare_cleared_after_${cfWait.waitMs}ms`)
        info.blocked_or_bot_detected = false // cleared!
      } else {
        info.steps.push('cloudflare_not_cleared')
        // Return early — no point extracting a challenge page
        await browser.close(); browser = null
        info.elapsed_ms = Date.now() - t0
        return { extracted: null, debugInfo: info, error: 'cloudflare_not_cleared' }
      }
    }

    // ── Phase 4: Wait for full load + networkidle ─────────────────────────
    try {
      await page.waitForLoadState('load', { timeout: 8000 })
      info.steps.push('load_state:ok')
    } catch {
      info.steps.push('load_state:timeout')
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: 7000 })
      info.steps.push('networkidle:ok')
    } catch {
      info.steps.push('networkidle:timeout')
    }

    // ── Phase 5: Wait for mint-relevant keywords ──────────────────────────
    try {
      await page.waitForFunction(
        (kws) => { const t = document.body?.innerText || ''; return kws.some(k => t.includes(k)) },
        WAIT_KEYWORDS,
        { timeout: 8000 },
      )
      info.steps.push('keywords:found')
    } catch {
      info.steps.push('keywords:timeout')
    }

    // ── Phase 6: Human mouse movement + gradual scroll ───────────────────
    await humanMouseMove(page)
    await humanScroll(page)
    info.steps.push('scroll:done')

    // Extra settle time after scroll
    await page.waitForTimeout(jitter(500, 600))

    // ── Phase 7: Screenshot (debug only) ─────────────────────────────────
    if (debugMode) {
      try {
        await page.screenshot({ path: '/tmp/opensea-debug.png', fullPage: true })
        info.screenshot_captured = true
        info.steps.push('screenshot:saved')
      } catch (e) {
        info.steps.push(`screenshot:failed:${String(e.message).slice(0, 60)}`)
      }
    }

    // ── Phase 8: Extract all data ─────────────────────────────────────────
    const extracted = await page.evaluate(() => {
      const body      = document.body
      const innerText = (body?.innerText || '').trim()
      const title     = document.title || ''
      const finalUrl  = window.location.href

      const STAGE_NAMES = [
        'Public Sale','Public Stage','Public Mint','Public',
        'Allowlist Sale','Allowlist Stage','Allowlist','Allow List',
        'Whitelist','WL','Presale','Pre-Sale','FCFS','GTD','Guaranteed',
        'Team Treasury','Treasury','Team','Claim','Open Edition',
        'Holder Mint','Holder','Raffle','OG','VIP','Community',
        'Early Access','Partner','Waitlist','Private',
      ]

      const stageElements = []
      try {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          const t = (node.textContent || '').trim()
          if (STAGE_NAMES.some(n => t.toLowerCase() === n.toLowerCase())) {
            let el = node.parentElement
            for (let i = 0; i < 8 && el && el !== body; i++) {
              if (el.innerText && el.innerText.length > 30 && el.innerText.length < 2000) break
              el = el.parentElement
            }
            if (el && el !== body) {
              stageElements.push({ stageName: t, cardText: (el.innerText || '').trim().slice(0, 600) })
            }
          }
        }
      } catch {}

      let nextDataJson = null
      try {
        if (window.__NEXT_DATA__) nextDataJson = JSON.stringify(window.__NEXT_DATA__).slice(0, 100000)
      } catch {}

      const selectorHits = {}
      for (const sel of [
        '[data-testid*="mint"]','[class*="mintSchedule"]','[class*="mint-schedule"]',
        '[class*="stage"]','[class*="phase"]','[data-testid*="stage"]',
      ]) {
        try { selectorHits[sel] = document.querySelectorAll(sel).length } catch {}
      }

      return {
        title,
        finalUrl,
        innerText:      innerText.slice(0, 80000),
        bodyTextSample: innerText.slice(0, 5000),
        iframeCount:    document.querySelectorAll('iframe').length,
        stageElements:  stageElements.slice(0, 25),
        hasNextData:    Boolean(nextDataJson),
        nextDataJson,
        selectorHits,
      }
    })

    info.steps.push('dom_extracted')

    // ── Populate debug fields ─────────────────────────────────────────────
    info.final_url           = extracted.finalUrl
    info.title               = extracted.title
    info.body_text_sample    = extracted.bodyTextSample
    info.iframe_count        = extracted.iframeCount
    info.selectors_found     = extracted.selectorHits
    info.inner_text_len      = extracted.innerText.length
    info.stage_elements      = extracted.stageElements.length
    info.has_next_data       = extracted.hasNextData
    info.schedule_text_found = /mint\s+schedule/i.test(extracted.innerText)
    info.mint_keywords_found = WAIT_KEYWORDS.filter(k => extracted.innerText.includes(k))

    // Final bot-check on actual page content
    const checkText = (extracted.title + ' ' + extracted.bodyTextSample).toLowerCase()
    if (BOT_PATTERNS.test(checkText)) {
      info.blocked_or_bot_detected = true
      info.steps.push('bot_still_detected_after_wait')
    }

    if (debugMode) {
      console.log(`[extractor:debug] title="${extracted.title}" url="${extracted.finalUrl}"`)
      console.log(`[extractor:debug] body[0:200]=${extracted.bodyTextSample.slice(0,200).replace(/\n/g,' ')}`)
    }

    await browser.close(); browser = null
    info.elapsed_ms = Date.now() - t0
    return { extracted, debugInfo: info }

  } catch (e) {
    info.steps.push(`fatal_error:${String(e.message).slice(0, 100)}`)
    info.elapsed_ms = Date.now() - t0
    return { extracted: null, debugInfo: info, error: e.message }
  } finally {
    if (browser) { try { await browser.close() } catch {} }
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

  const ORDER   = { live_now: 0, upcoming: 1, ended: 2, unknown: 3 }
  const sorted  = [...stages].sort((a, b) => {
    const od = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
    if (od !== 0) return od
    if (!a.start_time && !b.start_time) return 0
    if (!a.start_time) return 1
    if (!b.start_time) return -1
    return new Date(a.start_time) - new Date(b.start_time)
  })

  const live     = sorted.filter(s => s.status === 'live_now')
  const upcoming = sorted.filter(s => s.status === 'upcoming')
  const ended    = sorted.filter(s => s.status === 'ended')
  const current  = live[0]     || null
  const next     = upcoming[0] || null
  const primary  = current || next || sorted[0]

  const mintStatus =
    current                          ? 'live_now'
    : next                           ? 'upcoming'
    : ended.length === sorted.length ? 'ended'
    : 'needs_review'

  const hasWl = sorted.some(s => ['GTD','FCFS','RAFFLE'].includes(s.wl_type))

  let countdownText = null
  if (next?.start_time) {
    const ms = new Date(next.start_time).getTime() - Date.now()
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

async function handleExtract(pageUrl, debugMode = false) {
  const overallTimeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('extraction_timeout')), MAX_MS + 5000)
  )

  let browserResult
  try {
    browserResult = await Promise.race([
      extractFromBrowser(pageUrl, debugMode),
      overallTimeout,
    ])
  } catch (e) {
    return {
      ...buildResult([]),
      error:                     e.message,
      failure_reason:            'extraction_timeout_or_fatal',
      needs_manual_confirmation: true,
      debug: { error: e.message },
    }
  }

  const { extracted, debugInfo, error } = browserResult

  const cfFields = {
    cloudflare_resolved: debugInfo?.cloudflare_resolved ?? false,
    challenge_wait_ms:   debugInfo?.challenge_wait_ms   ?? 0,
    ua_used:             debugInfo?.ua_used             ?? UA,
  }

  if (!extracted) {
    return {
      ...buildResult([]),
      ...cfFields,
      error,
      failure_reason:            error || 'browser_extract_failed',
      blocked_or_bot_detected:   debugInfo?.blocked_or_bot_detected ?? false,
      needs_manual_confirmation: true,
      debug: debugInfo,
    }
  }

  if (debugInfo.blocked_or_bot_detected) {
    return {
      ...buildResult([]),
      ...cfFields,
      blocked_or_bot_detected:   true,
      failure_reason:            'blocked_or_bot_detected',
      needs_manual_confirmation: true,
      debug: debugInfo,
    }
  }

  const allStages = []
  const dedupeKey = new Set()

  function addStage(s) {
    if (!s || (!s.name && !s.start_time && s.price == null)) return
    const fp = `${s.name}|${s.start_time}|${s.price}`
    if (dedupeKey.has(fp)) return
    dedupeKey.add(fp)
    allStages.push(s)
  }

  // ── Source A: __NEXT_DATA__ from hydrated browser ─────────────────────
  if (extracted.nextDataJson) {
    const rawStages = extractStagesFromNextDataJson(extracted.nextDataJson)
    for (const raw of rawStages) addStage(normalizeRawStage(raw))
    if (rawStages.length) debugInfo.steps.push(`next_data_stages:${rawStages.length}`)
  }

  // ── Source B: DOM card text (TreeWalker stage elements) ───────────────
  if (extracted.stageElements.length) {
    debugInfo.steps.push(`dom_cards:${extracted.stageElements.length}`)
    for (const { stageName, cardText } of extracted.stageElements) {
      const def = matchStageDef(stageName.trim()) || { name: stageName, wl: guessWlType(stageName) }
      // Parse the card text as a mini block (name is def.name, rest is block)
      const lines   = cardText.split('\n').map(l => l.trim()).filter(Boolean)
      const nameIdx = lines.findIndex(l => l.trim().toLowerCase() === stageName.trim().toLowerCase())
      const block   = nameIdx >= 0 ? lines.slice(nameIdx + 1) : lines
      const stage   = extractStageFromBlock(def.name, def.wl, block)
      addStage(stage)
    }
  }

  // ── Source C: Full innerText parse ────────────────────────────────────
  if (extracted.innerText) {
    const parsed = parseRenderedText(extracted.innerText)
    if (parsed.stages.length) {
      debugInfo.steps.push(`innertext_stages:${parsed.stages.length}`)
      for (const s of parsed.stages) addStage(s)
    }
    if (!allStages.length && !parsed.rawScheduleFound) {
      debugInfo.steps.push('innertext:no_schedule_section')
    }
  }

  // ── Countdown fallback when no stages found ───────────────────────────
  if (!allStages.length) {
    const cdMatch = (extracted.innerText || '').match(/minting\s+in\b[\s\S]{0,200}/i)
    if (cdMatch) {
      const t = cdMatch[0]
      const d = Number((t.match(/(\d+)\s*d/i) || [])[1] || 0)
      const h = Number((t.match(/(\d+)\s*h/i) || [])[1] || 0)
      const m = Number((t.match(/(\d+)\s*m(?!o)/i) || [])[1] || 0)
      const ms = ((d * 86400) + (h * 3600) + (m * 60)) * 1000
      if (ms > 0) {
        const parts = []
        if (d) parts.push(`${d}d`)
        if (h) parts.push(`${h}h`)
        if (m && !d) parts.push(`${m}m`)
        debugInfo.steps.push('countdown_fallback')
        return {
          ...buildResult([]),
          ...cfFields,
          schedule_exposed:          false,
          mint_status:               'upcoming',
          mint_date:                 new Date(Date.now() + ms).toISOString(),
          countdown_text:            parts.join(' ') || '< 1m',
          needs_manual_confirmation: true,
          blocked_or_bot_detected:   false,
          failure_reason:            null,
          debug: debugInfo,
        }
      }
    }

    // Final: no signal
    const reason = debugInfo.schedule_text_found
      ? 'schedule_section_found_but_not_parsed'
      : debugInfo.mint_keywords_found.length > 0
        ? 'mint_keywords_found_but_no_stages'
        : 'no_mint_content_found'

    return {
      ...buildResult([]),
      ...cfFields,
      blocked_or_bot_detected:   false,
      failure_reason:            reason,
      needs_manual_confirmation: true,
      debug: debugInfo,
    }
  }

  const result = buildResult(allStages)
  debugInfo.steps.push(`final_stages:${allStages.length}`)

  return {
    ...result,
    ...cfFields,
    blocked_or_bot_detected: false,
    failure_reason:           null,
    debug: debugInfo,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP SERVER
// ────────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((res, rej) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 8192) rej(new Error('body_too_large')) })
    req.on('end', () => { try { res(JSON.parse(data)) } catch { res({}) } })
    req.on('error', rej)
  })
}

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type':            'application/json',
    'Content-Length':           Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(json)
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`)

  if (parsed.pathname === '/health') {
    return send(res, 200, { ok: true, ts: Date.now() })
  }

  if (parsed.pathname !== '/extract') {
    return send(res, 404, { error: 'not_found' })
  }

  // Auth
  if (SECRET) {
    const provided = req.headers['x-extractor-secret'] || req.headers['authorization']?.replace('Bearer ', '')
    if (provided !== SECRET) return send(res, 401, { error: 'unauthorized' })
  }

  let pageUrl   = parsed.searchParams.get('url') || ''
  const debugMode = parsed.searchParams.get('debug') === '1'

  if ((req.method === 'POST' || req.method === 'PUT') && !pageUrl) {
    try {
      const body = await readBody(req)
      pageUrl    = body.url || ''
    } catch {
      return send(res, 400, { error: 'invalid_body' })
    }
  }

  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
    return send(res, 400, { error: 'url_required', detail: 'Provide ?url= or POST { url }' })
  }

  if (!/opensea\.io\//i.test(pageUrl)) {
    return send(res, 400, { error: 'unsupported_url', detail: 'Only opensea.io URLs are supported' })
  }

  console.log(`[extractor] ${req.method} /extract url=${pageUrl} debug=${debugMode}`)

  try {
    const result = await handleExtract(pageUrl, debugMode)
    console.log(`[extractor] done stages=${result.stages?.length ?? 0} status=${result.mint_status} exposed=${result.schedule_exposed} failure=${result.failure_reason || 'none'}`)
    // Always include debug fields — strip body_text_sample unless ?debug=1
    if (!debugMode && result.debug) {
      delete result.debug.body_text_sample
    }
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
  console.log(`[extractor] OpenSea render extractor listening on :${PORT}`)
  console.log(`[extractor] secret=${SECRET ? 'set' : 'none'} timeout=${MAX_MS}ms`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT',  () => server.close(() => process.exit(0)))
