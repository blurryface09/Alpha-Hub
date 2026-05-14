import { normalizeProject } from '../normalize.js'

const DEFAULT_QUERY = `
  query AlphaHubRecentTokens {
    exploreList(first: 20, sort: TOP_GAINERS) {
      edges {
        node {
          name
          description
          address
          chainId
          collectionAddress
          image { url }
        }
      }
    }
  }
`

function mapChain(chainId, fallback) {
  const value = Number(chainId)
  if (value === 8453) return 'base'
  if (value === 7777777) return 'zora'
  if (value === 1) return 'eth'
  return fallback || 'zora'
}

function rowsFromGraphql(json) {
  const edges = json?.data?.exploreList?.edges || []
  return edges.map(edge => edge.node).filter(Boolean)
}

export async function fetchZoraProjects() {
  const endpoint = process.env.ZORA_API_URL
  if (!endpoint) return { projects: [], errors: ['ZORA_API_URL missing'] }

  try {
    const isGraphql = endpoint.includes('graphql')
    const response = await fetch(endpoint, {
      method: isGraphql ? 'POST' : 'GET',
      headers: isGraphql ? { 'Content-Type': 'application/json' } : undefined,
      body: isGraphql ? JSON.stringify({ query: DEFAULT_QUERY }) : undefined,
      signal: AbortSignal.timeout(8500),
    })
    if (!response.ok) throw new Error(`Zora ${response.status}`)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) throw new Error('Zora endpoint did not return JSON')
    const json = await response.json()
    const rows = isGraphql
      ? rowsFromGraphql(json)
      : (json.collections || json.projects || json.data || [])
    const projects = rows.slice(0, 20).map((item) => normalizeProject({
      name: item.name || item.collectionName || item.title,
      image_url: item.image?.url || item.image || item.image_url || item.media?.image,
      description: item.description,
      chain: mapChain(item.chainId, item.chain),
      contract_address: item.collectionAddress || item.contract || item.contractAddress || item.address,
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
