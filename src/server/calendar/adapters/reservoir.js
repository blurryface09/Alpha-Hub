import { normalizeProject } from '../normalize.js'

const HOSTS = {
  eth: 'https://api.reservoir.tools',
  base: 'https://api-base.reservoir.tools',
}

export async function fetchReservoirProjects({ limit = 12 } = {}) {
  const apiKey = process.env.RESERVOIR_API_KEY
  const headers = apiKey ? { 'x-api-key': apiKey } : {}
  const projects = []
  const errors = []

  for (const [chain, host] of Object.entries(HOSTS)) {
    try {
      const response = await fetch(`${host}/collections/trending/v1?limit=${Math.min(limit, 20)}`, {
        headers,
        signal: AbortSignal.timeout(8500),
      })
      if (!response.ok) throw new Error(`Reservoir ${chain} ${response.status}`)
      const json = await response.json()
      const rows = json.collections || json.results || []

      for (const item of rows) {
        const collection = item.collection || item
        const contract = collection.primaryContract || collection.contract || collection.contracts?.[0]
        projects.push(normalizeProject({
          name: collection.name,
          slug: collection.slug || collection.id,
          image_url: collection.image || collection.imageUrl || collection.metadata?.image,
          description: collection.description,
          chain,
          contract_address: contract,
          mint_url: collection.externalUrl || collection.openseaVerificationStatus ? collection.externalUrl : null,
          website_url: collection.externalUrl || null,
          source_url: collection.id ? `${host}/collections/v7?id=${encodeURIComponent(collection.id)}` : null,
          mint_count: Number(item.count || item.sales || collection.onSaleCount || 0),
          holder_count: Number(collection.ownerCount || 0),
          hype_score: Number(item.volume || item.volumeChange || 0) > 0 ? 35 : 20,
          source_confidence: contract ? 'medium' : 'low',
          status: 'approved',
        }, 'reservoir'))
      }
    } catch (error) {
      errors.push(error.message)
    }
  }

  return { projects, errors }
}
