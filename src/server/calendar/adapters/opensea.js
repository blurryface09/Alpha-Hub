import { normalizeProject } from '../normalize.js'
import { isAddressLikeName } from '../../../lib/calendarQuality.js'

function cleanCollectionName(collection) {
  const name = String(collection?.name || '').trim()
  if (!name || isAddressLikeName(name)) return null
  if (name.length < 3) return null
  return name
}

function primaryContract(collection) {
  const contracts = Array.isArray(collection?.contracts) ? collection.contracts : []
  return contracts.find(contract => contract?.address) || null
}

export async function fetchOpenSeaProjects({ limit = 12 } = {}) {
  const apiKey = process.env.OPENSEA_API_KEY
  if (!apiKey) return { projects: [], errors: ['OPENSEA_API_KEY missing'] }

  try {
    const response = await fetch(`https://api.opensea.io/api/v2/collections?limit=${Math.min(limit, 30)}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(8500),
    })
    if (!response.ok) throw new Error(`OpenSea ${response.status}`)
    const json = await response.json()
    const rows = json.collections || []
    const projects = rows
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
    return { projects, errors: [] }
  } catch (error) {
    return { projects: [], errors: [error.message] }
  }
}
