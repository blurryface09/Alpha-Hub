// api/metadata.js — Server-side project metadata extractor
// Supports: OpenSea, Zora, Magic Eden, Twitter/X, generic URLs
// Falls back to Groq AI for unknown sources

const OPENSEA_KEY = process.env.OPENSEA_API_KEY
const GROQ_KEY    = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY

// Normalise chain identifiers to our 3-value enum
const CHAIN_MAP = {
  ethereum: 'eth', eth: 'eth', mainnet: 'eth',
  base: 'base',
  bnb: 'bnb', bsc: 'bnb', binance: 'bnb',
  // Treat L2s / Zora network as eth for now (auto-mint uses EVM compat)
  zora: 'eth', oeth: 'eth', optimism: 'eth', op: 'eth',
  polygon: 'eth', matic: 'eth',
  blast: 'eth', arbitrum: 'eth', arb: 'eth',
}

// ── OpenSea API v2 ──────────────────────────────────────────────────────────
async function fetchOpenSea(slug) {
  if (!OPENSEA_KEY) return null
  try {
    const r = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, {
      headers: { 'X-API-KEY': OPENSEA_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    const d = await r.json()
    const contract = d.contracts?.[0]
    return {
      name:            d.name          || null,
      description:     d.description   || null,
      chain:           CHAIN_MAP[contract?.chain] || 'eth',
      contract_address:contract?.address || null,
      total_supply:    d.total_supply   || null,
      twitter_handle:  d.twitter_username ? `@${d.twitter_username}` : null,
      discord_url:     d.discord_url    || null,
    }
  } catch { return null }
}

// ── Groq AI fallback ────────────────────────────────────────────────────────
async function callGroq(url) {
  if (!GROQ_KEY) return null
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Extract NFT/crypto project metadata from this URL: ${url}

Return ONLY valid JSON, no markdown, no explanation:
{
  "name": "project name or null",
  "chain": "eth" | "base" | "bnb" | null,
  "contract_address": "0x... if visible in URL else null",
  "mint_price": "price like 0.08 if known else null",
  "notes": "one sentence describing the project"
}`,
        }],
        max_tokens: 200,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json()
    const text = d.choices?.[0]?.message?.content || ''
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch {}
  return null
}

// ── Main extractor ───────────────────────────────────────────────────────────
async function extractMetadata(rawUrl) {
  let url = rawUrl.trim()
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url

  let parsed
  try { parsed = new URL(url) } catch {
    return fail('Invalid URL')
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
  const path = parsed.pathname

  // Pull any 0x contract address out of the full URL
  const urlContractMatch = url.match(/0x[a-fA-F0-9]{40}/)
  const urlContract = urlContractMatch?.[0] || null

  // ── OpenSea ──────────────────────────────────────────────────────────────
  if (host === 'opensea.io') {
    const m = path.match(/\/collection\/([^/?#]+)/)
    if (m) {
      const slug = m[1]
      const api  = await fetchOpenSea(slug)

      if (api) {
        const hasContract = api.contract_address || urlContract
        return {
          name:             api.name,
          source_type:      'opensea',
          chain:            api.chain,
          contract_address: api.contract_address || urlContract,
          total_supply:     api.total_supply,
          twitter_handle:   api.twitter_handle,
          discord_url:      api.discord_url,
          notes:            api.description?.slice(0, 120) || `OpenSea: ${slug}`,
          confidence: {
            name:             'api_verified',
            chain:            'api_verified',
            contract_address: api.contract_address ? 'api_verified' : (urlContract ? 'url_extracted' : 'missing'),
            mint_date:        'missing',
            mint_price:       'missing',
          },
          missing_fields: [
            'mint_date', 'mint_price',
            ...(!hasContract ? ['contract_address'] : []),
          ],
        }
      }

      // No API key — derive from slug
      const name = slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
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

  // ── Zora ─────────────────────────────────────────────────────────────────
  if (host.includes('zora.co')) {
    // /collect/base:0xADDR  or  /collect/eth:0xADDR/TOKEN
    const m = path.match(/\/collect\/([^:/?#]+)(?::([^/?#]+))?/)
    if (m) {
      const chainSlug  = m[1].toLowerCase()
      const addrInPath = m[2]?.match(/0x[a-fA-F0-9]{40}/)?.[0] || urlContract
      const chain      = CHAIN_MAP[chainSlug] || 'eth'

      // Try Groq for a name since Zora URLs rarely have slugs
      const ai = await callGroq(url)

      return {
        name:             ai?.name || null,
        source_type:      'zora',
        chain,
        contract_address: addrInPath,
        notes:            ai?.notes || `Zora collection on ${chainSlug}`,
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

  // ── Magic Eden ───────────────────────────────────────────────────────────
  if (host.includes('magiceden.io') || host.includes('magiceden.dev')) {
    // /collections/ethereum/SLUG  or  /collections/solana/SLUG
    const m = path.match(/\/collections?\/([^/?#]+)\/([^/?#]+)/)
    if (m) {
      const chainSlug = m[1].toLowerCase()
      const slug      = m[2]
      const chain     = CHAIN_MAP[chainSlug]
      const name      = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

      if (!chain) {
        // Solana etc. — not supported for EVM auto-mint
        return {
          name,
          source_type:      'magiceden',
          chain:            null,
          contract_address: null,
          notes:            `Magic Eden (${chainSlug}) — EVM auto-mint not supported for this chain`,
          confidence: { name: 'url_extracted', chain: 'missing', contract_address: 'missing', mint_date: 'missing', mint_price: 'missing' },
          missing_fields:   ['chain', 'contract_address', 'mint_date', 'mint_price'],
          warning:          `${chainSlug} chain is not supported for auto-mint. You can still track this project manually.`,
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

  // ── Twitter / X ──────────────────────────────────────────────────────────
  if (host === 'twitter.com' || host === 'x.com') {
    const skip = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'search', 'compose', 'settings', 'intent'])
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

  // ── Generic / Groq fallback ───────────────────────────────────────────────
  const ai = await callGroq(url)

  if (ai?.name) {
    const hasContract = ai.contract_address || urlContract
    return {
      name:             ai.name,
      source_type:      'website',
      chain:            ai.chain || 'eth',
      contract_address: ai.contract_address || urlContract,
      mint_price:       ai.mint_price || null,
      notes:            ai.notes || null,
      confidence: {
        name:             'ai_inferred',
        chain:            ai.chain ? 'ai_inferred' : 'missing',
        contract_address: hasContract ? (ai.contract_address ? 'ai_inferred' : 'url_extracted') : 'missing',
        mint_date:        'missing',
        mint_price:       ai.mint_price ? 'ai_inferred' : 'missing',
      },
      missing_fields: [
        ...(!ai.chain ? ['chain'] : []),
        ...(!hasContract ? ['contract_address'] : []),
        'mint_date',
        ...(!ai.mint_price ? ['mint_price'] : []),
      ],
    }
  }

  // ── Last resort: URL text extraction ─────────────────────────────────────
  const parts  = path.split('/').filter(Boolean)
  const namePart = parts[parts.length - 1] || host.split('.')[0]
  const fallbackName = namePart.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  return {
    name:             fallbackName || null,
    source_type:      'website',
    chain:            'eth',
    contract_address: urlContract,
    confidence: {
      name:             fallbackName ? 'url_extracted' : 'missing',
      chain:            'missing',
      contract_address: urlContract ? 'url_extracted' : 'missing',
      mint_date:        'missing',
      mint_price:       'missing',
    },
    missing_fields: [
      ...(!fallbackName ? ['name'] : []),
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

// ── Vercel handler ───────────────────────────────────────────────────────────
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
