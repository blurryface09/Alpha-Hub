import { parseAbi } from 'viem'
import { getAuthToken } from './supabase'


export const CHAINS = {
  eth:  { id: 1,    name: 'Ethereum', symbol: 'ETH', explorer: 'etherscan.io' },
  base: { id: 8453, name: 'Base',     symbol: 'ETH', explorer: 'basescan.org' },
  bnb:  { id: 56,   name: 'BNB Chain',symbol: 'BNB', explorer: 'bscscan.com' },
}

// --- Etherscan V2 fetch with CORS proxy fallback -----------------
async function etherscanFetch(chainKey, params) {
  const chain = CHAINS[chainKey]
  if (!chain) return { status: '0', message: 'NOTOK', result: 'Unknown chain' }
  const token = await getAuthToken()
  if (!token) return { status: '0', message: 'NOTOK', result: 'Not authenticated' }

  const url = new URL('/api/etherscan', window.location.origin)
  url.searchParams.set('chainid', chain.id)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) { lastError = new Error('HTTP ' + r.status); continue }
      const d = await r.json()
      if (!d) { lastError = new Error('Empty response'); continue }
      if (d.status === '0' && d.message === 'NOTOK' && d.result && 
          !d.result.includes('No transactions') && 
          !d.result.includes('No records') &&
          !d.result.includes('No token')) {
        lastError = new Error(d.result)
        continue
      }
      return d
    } catch (e) {
      lastError = e
      continue
    }
  }
  // Always return a safe fallback — never return undefined
  console.error('etherscanFetch failed:', lastError?.message)
  return { status: '0', message: 'NOTOK', result: lastError?.message || 'Request failed' }
}

// --- Wallet Analysis ---------------------------------------------
export async function getWalletData(address, chainKey = 'eth') {
  const [balData, txData, tokenData, internalData] = await Promise.all([
    etherscanFetch(chainKey, { module: 'account', action: 'balance', address, tag: 'latest' }),
    etherscanFetch(chainKey, { module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, page: 1, offset: 50, sort: 'desc' }),
    etherscanFetch(chainKey, { module: 'account', action: 'tokentx', address, startblock: 0, endblock: 99999999, page: 1, offset: 20, sort: 'desc' }),
    etherscanFetch(chainKey, { module: 'account', action: 'txlistinternal', address, startblock: 0, endblock: 99999999, page: 1, offset: 20, sort: 'desc' }),
  ])

  const bal = (balData?.status === '1' && balData.result) ? (parseInt(balData.result) / 1e18).toFixed(4) : '0'
  const txs = (txData?.status === '1' && Array.isArray(txData.result)) ? txData.result : []
  const tokens = (tokenData?.status === '1' && Array.isArray(tokenData.result)) ? tokenData.result : []
  const internals = (internalData?.status === '1' && Array.isArray(internalData.result)) ? internalData.result : []
  
  // Check if we got any data at all
  if (bal === '0' && txs.length === 0 && tokens.length === 0) {
    const errMsg = txData?.result || balData?.result || 'No data returned'
    if (typeof errMsg === 'string' && !errMsg.includes('No transactions')) {
      throw new Error(errMsg)
    }
  }

  const sent = txs.filter(t => t.from.toLowerCase() === address.toLowerCase()).length
  const received = txs.length - sent
  const failed = txs.filter(t => t.isError === '1').length
  const volume = txs.reduce((s, t) => s + parseInt(t.value) / 1e18, 0).toFixed(3)
  const gasSpent = txs.reduce((s, t) => s + (parseInt(t.gasUsed || 0) * parseInt(t.gasPrice || 0)) / 1e18, 0).toFixed(5)

  // Jeet score
  const tokenBuys = {}, tokenSells = {}
  tokens.forEach(t => {
    const sym = t.tokenSymbol || 'UNKNOWN'
    const isOut = t.from.toLowerCase() === address.toLowerCase()
    if (isOut) tokenSells[sym] = (tokenSells[sym] || 0) + 1
    else tokenBuys[sym] = (tokenBuys[sym] || 0) + 1
  })
  const totalBought = Object.keys(tokenBuys).length
  const quickFlips = Object.keys(tokenSells).filter(s => tokenBuys[s]).length
  const jeetScore = totalBought > 0 ? Math.min(100, Math.round((quickFlips / totalBought) * 100)) : 0

  return { bal, txs, tokens, internals, sent, received, failed, volume, gasSpent, jeetScore, tokenBuys, tokenSells, totalBought, quickFlips }
}

// --- Contract Analysis -------------------------------------------
export async function getContractData(address, chainKey = 'eth') {
  const [abiData, srcData, txData] = await Promise.all([
    etherscanFetch(chainKey, { module: 'contract', action: 'getabi', address }),
    etherscanFetch(chainKey, { module: 'contract', action: 'getsourcecode', address }),
    etherscanFetch(chainKey, { module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, page: 1, offset: 25, sort: 'desc' }),
  ])

  const verified = abiData?.status === '1'
  const src = (srcData?.status === '1' && Array.isArray(srcData.result) && srcData.result[0]) ? srcData.result[0] : {}
  const txs = (txData?.status === '1' && Array.isArray(txData.result)) ? txData.result : []
  const unique = new Set(txs.map(t => t.from)).size
  const age = txs.length ? Math.round((Date.now() / 1000 - parseInt(txs[txs.length - 1].timeStamp)) / 86400) : 0
  const failRate = txs.length ? Math.round((txs.filter(t => t.isError === '1').length / txs.length) * 100) : 0

  const signals = [
    { label: 'Source code verified',     ok: verified,             weight: 30 },
    { label: 'Contract name found',       ok: src.ContractName !== '' && src.ContractName !== undefined, weight: 15 },
    { label: 'Has transaction history',   ok: txs.length > 2,      weight: 15 },
    { label: 'Multiple unique senders',   ok: unique > 5,          weight: 20 },
    { label: 'Contract age > 14 days',    ok: age > 14,            weight: 15 },
    { label: 'Low fail rate (<20%)',       ok: failRate < 20,       weight: 5  },
  ]
  const score = signals.reduce((s, sg) => s + (sg.ok ? sg.weight : 0), 0)

  return { verified, src, txs, unique, age, failRate, signals, score, contractName: src.ContractName || 'Unknown', sourceCode: src.SourceCode }
}

// --- Whale Activity Detection ------------------------------------
export async function getLatestActivity(address, chainKey = 'eth', lastTxHash = null) {
  const data = await etherscanFetch(chainKey, {
    module: 'account', action: 'txlist',
    address, startblock: 0, endblock: 99999999,
    page: 1, offset: 5, sort: 'desc'
  })

  const txs = data.status === '1' ? data.result : []
  if (!txs.length) return []

  // txs are sorted desc (newest first). Slice everything before the last known hash.
  const cutoffIdx = lastTxHash ? txs.findIndex(t => t.hash === lastTxHash) : -1
  const newTxs = cutoffIdx > 0 ? txs.slice(0, cutoffIdx) : cutoffIdx === 0 ? [] : txs.slice(0, 1)
  
  return newTxs.map(t => ({
    hash: t.hash,
    from: t.from,
    to: t.to,
    value: (parseInt(t.value) / 1e18).toFixed(4),
    methodId: t.input?.slice(0, 10) || '0x',
    isError: t.isError === '1',
    isMint: isMintTransaction(t),
    timestamp: new Date(parseInt(t.timeStamp) * 1000),
    chain: chainKey,
  }))
}

// --- Mint Detection ----------------------------------------------
const MINT_METHOD_IDS = new Set([
  '0x40993b26', // mint()
  '0x1249c58b', // mint()
  '0x6a627842', // mint(address)
  '0xa0712d68', // mint(uint256)
  '0x84bb1e42', // mint(address,uint256)
  '0xd85d3d27', // publicMint()
  '0x2db11544', // publicMint(uint256)
  '0xefef39a1', // purchase(uint256)
  '0x570d8e1d', // presaleMint()
  '0x8ecfffd8', // allowlistMint()
])

export function isMintTransaction(tx) {
  return MINT_METHOD_IDS.has(tx.input?.slice(0, 10))
}

export function decodeMethodName(methodId) {
  const methods = {
    '0xa9059cbb': 'Token Transfer',
    '0x23b872dd': 'Token Transfer From',
    '0x095ea7b3': 'Approve',
    '0x38ed1739': 'DEX Swap (Sell)',
    '0x7ff36ab5': 'DEX Buy',
    '0x18cbafe5': 'DEX Sell',
    '0xd0e30db0': 'Wrap ETH',
    '0x2e1a7d4d': 'Unwrap ETH',
    '0xa22cb465': 'NFT Approval',
    '0x42842e0e': 'NFT Transfer',
    '0x40993b26': '🟢 MINT',
    '0x1249c58b': '🟢 MINT',
    '0x6a627842': '🟢 MINT',
    '0xa0712d68': '🟢 MINT',
    '0x84bb1e42': '🟢 MINT',
    '0xd85d3d27': '🟢 PUBLIC MINT',
    '0x2db11544': '🟢 PUBLIC MINT',
    '0xefef39a1': '🟢 PURCHASE',
    '0x570d8e1d': '🟢 PRESALE MINT',
    '0x8ecfffd8': '🟢 ALLOWLIST MINT',
    '0x715018a6': 'Renounce Ownership',
    '0xf2fde38b': 'Transfer Ownership',
    '0x3ccfd60b': '🔴 Owner Withdraw',
  }
  return methods[methodId] || `Method ${methodId}`
}

// --- Execute Mint Transaction -------------------------------------
export async function buildMintTransaction({ contractAddress, chainKey, maxMint, gasLimit, walletClient }) {
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error('Unsupported chain')

  // Fetch ABI to find the right mint function
  const abiData = await etherscanFetch(chainKey, { module: 'contract', action: 'getabi', address: contractAddress })
  
  let abi
  if (abiData.status === '1') {
    try { abi = JSON.parse(abiData.result) } catch { abi = null }
  }

  // Fallback to common mint ABI if not verified
  const mintAbi = abi || parseAbi([
    'function mint(uint256 quantity) payable',
    'function mint() payable',
    'function publicMint(uint256 quantity) payable',
  ])

  return { contractAddress, abi: mintAbi, chainKey, maxMint, gasLimit }
}
