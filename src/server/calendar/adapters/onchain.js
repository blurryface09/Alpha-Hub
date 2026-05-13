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

function decodeHexString(hex) {
  const value = String(hex || '')
  if (!value || value === '0x') return null

  try {
    if (value.length === 66) {
      const bytes = value.slice(2).match(/.{1,2}/g) || []
      const decoded = bytes
        .map(byte => String.fromCharCode(parseInt(byte, 16)))
        .join('')
        .replace(/\0/g, '')
        .trim()
      return decoded || null
    }

    const lengthHex = value.slice(130, 194)
    const length = parseInt(lengthHex || '0', 16)
    if (!length || !Number.isFinite(length)) return null
    const data = value.slice(194, 194 + length * 2)
    const bytes = data.match(/.{1,2}/g) || []
    const decoded = bytes
      .map(byte => String.fromCharCode(parseInt(byte, 16)))
      .join('')
      .trim()
    return decoded || null
  } catch {
    return null
  }
}

async function callContract(url, to, selector) {
  try {
    const result = await rpc(url, 'eth_call', [{ to, data: selector }, 'latest'])
    return result && result !== '0x' ? result : null
  } catch {
    return null
  }
}

async function fetchContractMetadata(url, contract) {
  const [nameRaw, symbolRaw, supplyRaw] = await Promise.all([
    callContract(url, contract, '0x06fdde03'), // name()
    callContract(url, contract, '0x95d89b41'), // symbol()
    callContract(url, contract, '0x18160ddd'), // totalSupply()
  ])

  const name = decodeHexString(nameRaw)
  const symbol = decodeHexString(symbolRaw)
  const totalSupply = supplyRaw ? parseInt(supplyRaw, 16) : null

  return {
    name,
    symbol,
    totalSupply: Number.isFinite(totalSupply) && totalSupply <= 2147483647 ? totalSupply : null,
  }
}

function contractFallbackName(contract, symbol) {
  if (symbol) return `${symbol} Mint`
  return `New NFT Contract ${contract.slice(0, 6)}...${contract.slice(-4)}`
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
        const metadata = await fetchContractMetadata(url, contract)
        const hasName = Boolean(metadata.name || metadata.symbol)
        projects.push(normalizeProject({
          name: metadata.name || contractFallbackName(contract, metadata.symbol),
          chain,
          contract_address: contract,
          description: hasName
            ? `${metadata.name || metadata.symbol} has active mint-style transfer activity on ${chain === 'base' ? 'Base' : 'Ethereum'}. Review the contract and official links before minting.`
            : `Alpha Hub detected live NFT mint activity from this contract. Project metadata was not available from the contract, so verify the official source before tracking.`,
          mint_count: mintCount,
          holder_count: metadata.totalSupply,
          status: hasName ? 'live' : 'pending_review',
          source_confidence: hasName ? 'medium' : 'low',
          mint_date: new Date().toISOString(),
          mint_date_source: 'onchain.mint_activity',
          mint_date_confidence: 'medium',
          mint_type: 'detected',
          hype_score: hasName ? Math.min(60, 15 + mintCount * 2) : Math.min(35, 10 + mintCount),
          hidden_gem_score: Math.min(80, 25 + mintCount),
          risk_score: hasName ? 50 : 65,
        }, 'onchain'))
      }
    } catch (error) {
      errors.push(`${chain}: ${error.message}`)
    }
  }

  return { projects, errors }
}
