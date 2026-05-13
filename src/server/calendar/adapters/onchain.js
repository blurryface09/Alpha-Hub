import { normalizeProject } from '../normalize.js'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000'

function rpcFor(chain) {
  if (chain === 'base') return process.env.BASE_RPC_URL
  return process.env.ETH_RPC_URL
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

export async function fetchOnchainProjects({ limit = 20 } = {}) {
  const projects = []
  const errors = []

  for (const chain of ['base', 'eth']) {
    const url = rpcFor(chain)
    if (!url) {
      errors.push(`${chain.toUpperCase()}_RPC_URL missing`)
      continue
    }

    try {
      const latestHex = await rpc(url, 'eth_blockNumber', [])
      const latest = parseInt(latestHex, 16)
      const fromBlock = `0x${Math.max(0, latest - (chain === 'base' ? 1800 : 450)).toString(16)}`
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

      for (const [contract, mintCount] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
        projects.push(normalizeProject({
          name: `Detected Mint ${contract.slice(0, 6)}...${contract.slice(-4)}`,
          chain,
          contract_address: contract,
          mint_count: mintCount,
          status: 'live',
          source_confidence: 'medium',
          mint_date: new Date().toISOString(),
          mint_date_source: 'onchain.mint_activity',
          mint_date_confidence: 'medium',
          hype_score: Math.min(70, 20 + mintCount * 2),
          hidden_gem_score: Math.min(85, 25 + mintCount),
          risk_score: 55,
        }, 'onchain'))
      }
    } catch (error) {
      errors.push(`${chain}: ${error.message}`)
    }
  }

  return { projects, errors }
}
