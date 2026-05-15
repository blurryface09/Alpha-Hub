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
  const stageInfo = activeStage(drop)
  const mintDate = parseDate(firstDefined(drop?.start_time, drop?.startTime, drop?.start_date, drop?.startDate)) || stageInfo?.start || null
  const mintEndDate = parseDate(firstDefined(drop?.end_time, drop?.endTime, drop?.end_date, drop?.endDate)) || stageInfo?.end || null
  const mintType = stageInfo ? stagePhase(stageInfo.stage) : stagePhase(drop)
  const mintUrl = dropMintUrl(drop, slug)
  const status = dropStatus(drop, stageInfo)
  const name = cleanCollectionName(drop?.collection || drop) || cleanCollectionName(drop) || 'OpenSea Drop'
  const missing = missingFields({ contract, mintUrl, mintDate, mintType })
  const verified = missing.length === 0 && status !== 'needs_review'
  const chain = contract?.chain || drop?.chain || drop?.collection?.chain || 'eth'
  const sourceUrl = collectionUrl(slug, drop?.opensea_url || drop?.collection?.opensea_url)

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
    mint_price: dropPrice(drop, stageInfo?.stage),
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
      stages: getStages(drop).slice(0, 5),
      missing_fields: missing,
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
    for (const type of ['featured', 'upcoming', 'recently_minted']) {
      try {
        const json = await openSeaJson('/drops', { searchParams: { type, limit: Math.min(limit, 30) } })
        const rows = json.drops || json.results || json.collections || []
        for (const row of rows) {
          const normalized = normalizeOpenSeaDrop(row)
          projects.push(normalized)
          console.log('Alpha Radar source', {
            source: 'opensea_drops',
            name: normalized.name,
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
