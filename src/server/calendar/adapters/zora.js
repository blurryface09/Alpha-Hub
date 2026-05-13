import { normalizeProject } from '../normalize.js'

export async function fetchZoraProjects() {
  const endpoint = process.env.ZORA_API_URL
  if (!endpoint) return { projects: [], errors: ['ZORA_API_URL missing'] }

  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8500) })
    if (!response.ok) throw new Error(`Zora ${response.status}`)
    const json = await response.json()
    const rows = json.collections || json.projects || json.data || []
    const projects = rows.slice(0, 20).map((item) => normalizeProject({
      name: item.name || item.collectionName || item.title,
      image_url: item.image || item.image_url || item.media?.image,
      description: item.description,
      chain: item.chain || 'zora',
      contract_address: item.contract || item.contractAddress || item.address,
      mint_url: item.mintUrl || item.url,
      source_url: item.url || item.mintUrl,
      mint_count: Number(item.mintCount || item.mints || 0),
      status: 'approved',
      source_confidence: item.contract || item.contractAddress ? 'medium' : 'low',
      hype_score: 25,
    }, 'zora'))
    return { projects, errors: [] }
  } catch (error) {
    return { projects: [], errors: [error.message] }
  }
}
