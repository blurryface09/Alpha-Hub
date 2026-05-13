import { normalizeProject } from '../normalize.js'

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
    const projects = rows.map((collection) => normalizeProject({
      name: collection.name,
      slug: collection.collection,
      image_url: collection.image_url,
      description: collection.description,
      chain: collection.contracts?.[0]?.chain || 'eth',
      contract_address: collection.contracts?.[0]?.address,
      mint_url: collection.project_url || collection.opensea_url,
      website_url: collection.project_url,
      source_url: collection.opensea_url,
      source_confidence: collection.contracts?.[0]?.address ? 'medium' : 'low',
      status: 'approved',
      hype_score: 30,
    }, 'opensea'))
    return { projects, errors: [] }
  } catch (error) {
    return { projects: [], errors: [error.message] }
  }
}
