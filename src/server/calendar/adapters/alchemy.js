import { normalizeProject } from '../normalize.js'
import { isAddressLikeName } from '../../../lib/calendarQuality.js'

const CHAINS = {
  eth: {
    rpcEnv: 'ETH_RPC_URL',
    fallbackRpc: key => `https://eth-mainnet.g.alchemy.com/v2/${key}`,
    nftBase: key => `https://eth-mainnet.g.alchemy.com/nft/v3/${key}`,
    label: 'Ethereum',
  },
  base: {
    rpcEnv: 'BASE_RPC_URL',
    fallbackRpc: key => `https://base-mainnet.g.alchemy.com/v2/${key}`,
    nftBase: key => `https://base-mainnet.g.alchemy.com/nft/v3/${key}`,
    label: 'Base',
  },
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000'

function apiKey() {
  return process.env.ALCHEMY_API_KEY || process.env.VITE_ALCHEMY_API_KEY
}

function rpcUrl(chain, key) {
  return process.env[CHAINS[chain].rpcEnv] || CHAINS[chain].fallbackRpc(key)
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(8500),
  })
  if (!response.ok) throw new Error(`RPC ${response.status}`)
  const json = await response.json()
  if (json.error) throw new Error(json.error.message || 'RPC error')
  return json.result
}

async function discoverMintContracts(chain, key, limit) {
  const url = rpcUrl(chain, key)
  const latestHex = await rpc(url, 'eth_blockNumber', [])
  const latest = parseInt(latestHex, 16)
  const blockWindow = chain === 'base' ? 2500 : 550
  const fromBlock = `0x${Math.max(0, latest - blockWindow).toString(16)}`
  const logs = await rpc(url, 'eth_getLogs', [{
    fromBlock,
    toBlock: 'latest',
    topics: [TRANSFER_TOPIC, ZERO_TOPIC],
  }])

  const counts = new Map()
  for (const log of logs || []) {
    const address = String(log.address || '').toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(address)) continue
    counts.set(address, (counts.get(address) || 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([contract, mintCount]) => ({ contract, mintCount }))
}

async function fetchContractMetadata(chain, key, contract) {
  const url = `${CHAINS[chain].nftBase(key)}/getContractMetadata?contractAddress=${encodeURIComponent(contract)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(8500) })
  if (!response.ok) throw new Error(`Alchemy metadata ${chain} ${response.status}`)
  return response.json()
}

/**
 * Fetch the timestamp of the first mint (Transfer from 0x0) for a contract.
 * Returns an ISO string or null if unavailable.
 */
async function fetchFirstMintTimestamp(chain, key, contract) {
  try {
    const url = rpcUrl(chain, key)
    // Get earliest mint log for this contract
    const logs = await rpc(url, 'eth_getLogs', [{
      fromBlock: '0x0',
      toBlock: 'latest',
      address: contract,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC],
    }])
    if (!logs?.length) return null
    // Logs sorted oldest-first by default — take the first one
    const firstLog = logs[0]
    if (!firstLog?.blockNumber) return null
    const block = await rpc(url, 'eth_getBlockByNumber', [firstLog.blockNumber, false])
    if (!block?.timestamp) return null
    const ts = parseInt(block.timestamp, 16) * 1000
    return Number.isFinite(ts) ? new Date(ts).toISOString() : null
  } catch {
    return null
  }
}

function pickMetadata(json) {
  const meta = json?.contractMetadata || json || {}
  const openSea = meta.openSeaMetadata || meta.openSea || {}
  const name = openSea.collectionName || meta.name || meta.symbol || null
  const image = openSea.imageUrl || openSea.image_url || meta.imageUrl || meta.image || null
  const description = openSea.description || meta.description || null
  const externalUrl = openSea.externalUrl || openSea.external_url || meta.externalUrl || null
  const discord = openSea.discordUrl || openSea.discord_url || null
  const twitter = openSea.twitterUsername
    ? `https://x.com/${String(openSea.twitterUsername).replace(/^@/, '')}`
    : null
  const tokenType = meta.tokenType || meta.contractDeployer || null
  const verified = ['verified', 'approved'].includes(String(openSea.safelistRequestStatus || '').toLowerCase())

  return {
    name,
    image,
    description,
    externalUrl,
    discord,
    twitter,
    tokenType,
    verified,
    floorPrice: openSea.floorPrice || null,
  }
}

function safeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 2147483647 ? Math.floor(number) : null
}

export async function fetchAlchemyProjects({ limit = 12 } = {}) {
  const key = apiKey()
  if (!key) return { projects: [], errors: ['ALCHEMY_API_KEY missing'] }

  const projects = []
  const errors = []

  for (const chain of Object.keys(CHAINS)) {
    try {
      const contracts = await discoverMintContracts(chain, key, Math.min(limit, 15))
      for (const { contract, mintCount } of contracts) {
        try {
          const json = await fetchContractMetadata(chain, key, contract)
          const meta = pickMetadata(json)
          if (!meta.name || isAddressLikeName(meta.name)) {
            errors.push(`${chain}:${contract}: metadata missing name`)
            continue
          }

          // Derive mint_date from on-chain first-mint block timestamp
          // This makes Alchemy results visible in the calendar (previously always null)
          const firstMintAt = await fetchFirstMintTimestamp(chain, key, contract)
          const now = Date.now()
          const firstMintMs = firstMintAt ? new Date(firstMintAt).getTime() : null
          // If first mint was within the last 72h, treat as currently live/active
          // Otherwise it's a historical discovery — still show with its real mint_date
          const mintStatus = firstMintMs && (now - firstMintMs) < 72 * 60 * 60 * 1000
            ? 'live_now'
            : 'ended'

          projects.push(normalizeProject({
            name: meta.name,
            image_url: meta.image,
            description: meta.description || `${meta.name} has recent NFT mint activity on ${CHAINS[chain].label}.`,
            chain,
            contract_address: contract,
            mint_url: meta.externalUrl,
            website_url: meta.externalUrl,
            x_url: meta.twitter,
            discord_url: meta.discord,
            source_url: meta.externalUrl,
            mint_date: firstMintAt,
            mint_date_source: 'alchemy.first_mint_block',
            mint_date_confidence: firstMintAt ? 'high' : 'low',
            mint_type: meta.tokenType || 'detected',
            status: 'pending_review',
            mint_status: mintStatus,
            source_confidence: meta.verified ? 'high' : 'medium',
            mint_count: mintCount,
            holder_count: safeInteger(json?.contractMetadata?.totalSupply || json?.totalSupply),
            hype_score: Math.min(75, 25 + mintCount * 2 + (meta.verified ? 10 : 0) + (meta.image ? 5 : 0)),
            hidden_gem_score: Math.min(80, 25 + mintCount + (meta.verified ? 5 : 0)),
            risk_score: meta.verified ? 35 : 50,
          }, 'alchemy'))
        } catch (error) {
          errors.push(`${chain}:${contract}: ${error.message}`)
        }
      }
    } catch (error) {
      errors.push(`${chain}: ${error.message}`)
    }
  }

  return { projects, errors }
}
