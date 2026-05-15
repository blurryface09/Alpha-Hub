// api/metadata.js — Server-side project metadata extractor
// Supports: OpenSea collection + drops, Zora, Magic Eden, Twitter/X,
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
  if (s.includes('gtd') || s.includes('guaranteed'))                     return 'GTD'
  if (s.includes('fcfs'))                                                 return 'FCFS'
  if (s.includes('raffle'))                                               return 'RAFFLE'
  if (s.includes('allow') || s.includes('whitelist') || s === 'wl' ||
      s.includes('private') || s.includes('presale'))                     return 'GTD'
  if (s.includes('public') || s.includes('open') || s.includes('claim')) return 'PUBLIC'
  return 'UNKNOWN'
}

// ── Stage → display mint_phase (no DB constraint) ────────────────────────────
function stageToMintPhase(stage) {
  const s = String(stage || '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s.includes('gtd') || s.includes('guaranteed'))             return 'gtd'
  if (s.includes('allow') || s.includes('whitelist') || s === 'wl' ||
      s.includes('private') || s.includes('presale'))            return 'wl'
  if (s.includes('public') && s.includes('fcfs'))                return 'public_fcfs'
  if (s.includes('fcfs'))                                        return 'wl_fcfs'
  if (s.includes('open_edition') ||
     (s.includes('open') && s.includes('edition')))              return 'open_edition'
  if (s.includes('claim'))                                       return 'claim'
  if (s.includes('public'))                                      return 'public'
  return 'unknown'
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
      name:             d.name             || null,
      description:      d.description      || null,
      chain:            CHAIN_MAP[contract?.chain?.toLowerCase()] || 'eth',
      contract_address: contract?.address  || null,
      total_supply:     d.total_supply      || null,
      twitter_handle:   d.twitter_username ? `@${d.twitter_username}` : null,
      discord_url:      d.discord_url       || null,
    }
  } catch { return null }
}

// ── OpenSea Drops — mint timing, price, phase ─────────────────────────────────
async function fetchOpenSeaDrops(slug) {
  if (!OPENSEA_KEY) return null
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/drops?collection_slug=${encodeURIComponent(slug)}&order_by=start_date&limit=10`,
      { headers: { 'X-API-KEY': OPENSEA_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(5000) }
    )
    if (!r.ok) return null
    const d = await r.json()
    const drops = Array.isArray(d.drops) ? d.drops : []
    if (!drops.length) return null

    const now = new Date()
    // Prefer upcoming or currently-active drop over ended ones
    const relevant =
      drops.find(dr => {
        const start = dr.start_date ? new Date(dr.start_date) : null
        const end   = dr.end_date   ? new Date(dr.end_date)   : null
        if (!start) return false
        if (end && end < now) return false // skip ended
        return true
      }) ?? drops[drops.length - 1] // fall back to last if all ended

    return {
      mint_date:      relevant.start_date                          || null,
      end_date:       relevant.end_date                            || null,
      mint_price:     relevant.mint_price != null ? String(relevant.mint_price) : null,
      stage_name:     relevant.stage_name                          || null,
      max_per_wallet: relevant.max_per_wallet                      || null,
      stages: drops.map(dr => ({
        stage: dr.stage_name,
        start: dr.start_date,
        end:   dr.end_date,
        price: dr.mint_price != null ? String(dr.mint_price) : null,
      })),
    }
  } catch { return null }
}

// ── Groq AI fallback ──────────────────────────────────────────────────────────
async function callGroq(prompt, maxTokens = 256) {
  if (!GROQ_KEY) return null
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  maxTokens,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json()
    const text = d.choices?.[0]?.message?.content || ''
    const m = text.match(/\{[\s\S]*\}/)
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

// ── Plain alpha text (e.g. "CoolProject minting May 20 0.08 ETH") ─────────────
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

  // ── OpenSea ────────────────────────────────────────────────────────────────
  if (host === 'opensea.io') {
    const m = path.match(/\/collection\/([^/?#]+)/)
    if (m) {
      const slug = m[1]
      // Fetch collection metadata and drops in parallel
      const [api, drop] = await Promise.all([fetchOpenSea(slug), fetchOpenSeaDrops(slug)])

      if (api) {
        const hasContract = api.contract_address || urlContract
        const hasDate     = Boolean(drop?.mint_date)
        const hasPrice    = Boolean(drop?.mint_price)
        return {
          name:             api.name,
          source_type:      'opensea',
          chain:            api.chain,
          contract_address: api.contract_address || urlContract,
          total_supply:     api.total_supply,
          twitter_handle:   api.twitter_handle,
          discord_url:      api.discord_url,
          mint_date:        drop?.mint_date      || null,
          end_date:         drop?.end_date       || null,
          mint_price:       drop?.mint_price     || null,
          mint_phase:       drop?.stage_name ? stageToMintPhase(drop.stage_name) : null,
          wl_type:          drop?.stage_name ? stageToWlType(drop.stage_name)    : 'UNKNOWN',
          max_per_wallet:   drop?.max_per_wallet || null,
          stages:           drop?.stages         || null,
          notes:            api.description?.slice(0, 120) || `OpenSea: ${slug}`,
          confidence: {
            name:             'api_verified',
            chain:            'api_verified',
            contract_address: api.contract_address
              ? 'api_verified' : (urlContract ? 'url_extracted' : 'missing'),
            mint_date:        hasDate  ? 'api_verified' : 'missing',
            mint_price:       hasPrice ? 'api_verified' : 'missing',
          },
          missing_fields: [
            ...(!hasDate     ? ['mint_date']        : []),
            ...(!hasPrice    ? ['mint_price']        : []),
            ...(!hasContract ? ['contract_address']  : []),
          ],
        }
      }

      // No API key — derive from slug only
      const name = slug.split('-').map(w => (w[0] || '').toUpperCase() + w.slice(1)).join(' ')
      return {
        name,
        source_type:      'opensea',
        chain:            'eth',
        contract_address: urlContract,
        notes:            `OpenSea collection: ${slug}`,
        confidence: {
          name:             'url_extracted',
          chain:            'url_extracted',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date:        'missing',
          mint_price:       'missing',
        },
        missing_fields: [
          'mint_date', 'mint_price',
          ...(!urlContract ? ['contract_address'] : []),
        ],
      }
    }
  }

  // ── Zora ───────────────────────────────────────────────────────────────────
  if (host.includes('zora.co')) {
    const m = path.match(/\/collect\/([^:/?#]+)(?::([^/?#]+))?/)
    if (m) {
      const chainSlug  = m[1].toLowerCase()
      const addrInPath = (m[2] || '').match(/0x[a-fA-F0-9]{40}/)?.[0] || urlContract
      const chain      = CHAIN_MAP[chainSlug] || 'eth'
      const ai         = await callGroq(
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

  // ── Magic Eden ─────────────────────────────────────────────────────────────
  if (host.includes('magiceden.io') || host.includes('magiceden.dev')) {
    const m = path.match(/\/collections?\/([^/?#]+)\/([^/?#]+)/)
    if (m) {
      const chainSlug = m[1].toLowerCase()
      const slug      = m[2]
      const chain     = CHAIN_MAP[chainSlug]
      const name      = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      if (!chain) {
        return {
          name,
          source_type:      'magiceden',
          chain:            null,
          contract_address: null,
          notes:            `Magic Eden (${chainSlug}) — EVM auto-mint not supported`,
          warning:          `${chainSlug} chain is not supported for auto-mint. You can still track manually.`,
          confidence: {
            name: 'url_extracted', chain: 'missing',
            contract_address: 'missing', mint_date: 'missing', mint_price: 'missing',
          },
          missing_fields: ['chain', 'contract_address', 'mint_date', 'mint_price'],
        }
      }
      return {
        name,
        source_type:      'magiceden',
        chain,
        contract_address: urlContract,
        notes:            `Magic Eden: ${chainSlug} collection`,
        confidence: {
          name:             'url_extracted',
          chain:            'url_extracted',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date:        'missing',
          mint_price:       'missing',
        },
        missing_fields: [
          'mint_date', 'mint_price',
          ...(!urlContract ? ['contract_address'] : []),
        ],
      }
    }
  }

  // ── Twitter / X ────────────────────────────────────────────────────────────
  if (host === 'twitter.com' || host === 'x.com') {
    const skip = new Set([
      'i','home','explore','notifications','messages','search','compose','settings','intent',
    ])
    const m = path.match(/^\/([^/?#]+)/)
    if (m && !skip.has(m[1].toLowerCase())) {
      const handle = m[1]
      return {
        name:             handle,
        source_type:      'twitter',
        chain:            'eth',
        contract_address: urlContract,
        twitter_handle:   `@${handle}`,
        notes:            `Twitter: @${handle}`,
        confidence: {
          name:             'url_extracted',
          chain:            'missing',
          contract_address: urlContract ? 'url_extracted' : 'missing',
          mint_date:        'missing',
          mint_price:       'missing',
        },
        missing_fields: [
          'mint_date', 'mint_price',
          ...(!urlContract ? ['contract_address'] : []),
        ],
      }
    }
  }

  // ── Generic / Groq fallback ────────────────────────────────────────────────
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
        name:             'ai_inferred',
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
    confidence: {
      name: 'missing', chain: 'missing', contract_address: 'missing',
      mint_date: 'missing', mint_price: 'missing',
    },
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
