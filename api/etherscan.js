import { requireUser } from './_lib/auth.js'
import { cacheGet, cacheSet, rateLimit, sendRateLimit } from './_lib/redis.js'
import { createPublicClient, http, parseAbi } from 'viem'
import { mainnet, base, bsc } from 'viem/chains'

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api'
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const ALLOWED_MODULES = new Set(['account', 'contract'])
const ALLOWED_ACTIONS = new Set([
  'balance',
  'txlist',
  'tokentx',
  'txlistinternal',
  'getabi',
  'getsourcecode',
])
const CHAIN_IDS = new Set(['1', '8453', '56'])
const AI_SYSTEM = `You are an expert on-chain forensics analyst and smart contract auditor for a professional crypto and NFT trading community. You have deep knowledge of DeFi protocols, DEX mechanics, NFT markets, MEV/sandwich attacks, rug pull patterns, and on-chain behavior analysis. You give structured forensic reports with clear section headers. You decode failed transactions precisely, identify bot behavior, jeet patterns, honeypots and contract backdoors. You write in direct crypto community language. No financial disclaimers. Ever.`
const AI_LIMITS = {
  wallet: { maxTokens: 2048 },
  contract: { maxTokens: 2048 },
  whale: { maxTokens: 512 },
  project: { maxTokens: 1024 },
}
const CHAIN_MAP = {
  '1': { key: 'eth', chain: mainnet },
  '8453': { key: 'base', chain: base },
  '56': { key: 'bnb', chain: bsc },
}
const TIME_FUNCTIONS = [
  'mintStartTime',
  'publicSaleStart',
  'publicSaleStartTime',
  'saleStart',
  'saleStartTime',
  'whitelistStart',
  'whitelistStartTime',
  'presaleStart',
  'presaleStartTime',
  'startTime',
  'startTimestamp',
  'mintStart',
  'allowlistStart',
  'allowlistStartTime',
]

function rpcUrlFor(chainId) {
  if (chainId === '8453') return process.env.BASE_RPC_URL || `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ''}`
  if (chainId === '56') return process.env.BNB_RPC_URL || `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ''}`
  return process.env.ETH_RPC_URL || `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ''}`
}

function normalizeTimestamp(value) {
  const numberValue = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null
  const millis = numberValue > 10_000_000_000 ? numberValue : numberValue * 1000
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

async function detectContractTime(contractAddress, chainId) {
  const cfg = CHAIN_MAP[chainId]
  const rpcUrl = rpcUrlFor(chainId)
  if (!cfg || !rpcUrl || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress || '')) return null
  const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) })

  for (const functionName of TIME_FUNCTIONS) {
    try {
      const abi = parseAbi([`function ${functionName}() view returns (uint256)`])
      const raw = await client.readContract({
        address: contractAddress,
        abi,
        functionName,
      })
      const mintDate = normalizeTimestamp(raw)
      if (mintDate) {
        return {
          mintDate,
          source: `contract.${functionName}`,
          confidence: 'high',
          rawValue: raw.toString(),
          notes: 'Read directly from the project contract. Confirm before saving.',
        }
      }
    } catch {}
  }
  return null
}

function detectPageTime(text) {
  const haystack = String(text || '').replace(/\s+/g, ' ').slice(0, 80_000)
  const labelPattern = /(mint starts|public sale|whitelist|allowlist|sale begins|launch date|countdown)[^.!?]{0,120}/ig
  const matches = haystack.match(labelPattern) || []
  for (const match of matches.slice(0, 12)) {
    const cleaned = match.replace(/countdown/ig, '').trim()
    const parsed = Date.parse(cleaned)
    if (Number.isFinite(parsed)) {
      return {
        mintDate: new Date(parsed).toISOString(),
        source: 'page',
        confidence: 'medium',
        rawValue: match,
        notes: 'Detected from page text. Verify from the official project source.',
      }
    }
  }
  return null
}

async function detectMintTime(req, res, user) {
  const limited = await rateLimit(`rl:mint-time:${user.id}`, 20, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const { contractAddress, chainId = '1', mintUrl } = req.body || {}
  const chainid = String(chainId)
  if (!CHAIN_IDS.has(chainid)) return res.status(400).json({ ok: false, error: 'Unsupported chain' })

  const contractResult = await detectContractTime(contractAddress, chainid)
  if (contractResult) return res.status(200).json({ ok: true, detected: true, ...contractResult })

  if (mintUrl && /^https?:\/\//i.test(mintUrl)) {
    try {
      const response = await fetch(mintUrl, { signal: AbortSignal.timeout(8000) })
      const html = await response.text()
      const pageResult = detectPageTime(html)
      if (pageResult) return res.status(200).json({ ok: true, detected: true, ...pageResult })
    } catch (error) {
      console.error('mint time page detection failed:', error.message)
    }
  }

  return res.status(200).json({
    ok: true,
    detected: false,
    message: 'No reliable mint time found. Please enter manually.',
  })
}

async function handleAiAnalysis(req, res, user) {
  const limited = await rateLimit(`rl:ai:${user.id}`, 20, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const apiKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'AI key is not configured on the server' })

  const { type = 'wallet', prompt } = req.body || {}
  const limit = AI_LIMITS[type]
  if (!limit) return res.status(400).json({ error: 'Unknown AI analysis type' })

  const content = String(prompt || '').slice(0, 12000)
  if (!content) return res.status(400).json({ error: 'Prompt is required' })

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content },
        ],
        max_tokens: limit.maxTokens,
        temperature: type === 'project' ? 0.4 : 0.7,
      }),
    })

    const data = await upstream.json().catch(() => null)
    if (!upstream.ok || data?.error) {
      return res.status(upstream.ok ? 502 : upstream.status).json({
        error: data?.error?.message || 'AI provider request failed',
      })
    }

    return res.status(200).json({
      content: data?.choices?.[0]?.message?.content || 'Analysis unavailable.',
    })
  } catch (error) {
    return res.status(502).json({ error: 'AI provider unavailable' })
  }
}

export default async function handler(req, res) {
  if (req.query.tool === 'ai-analysis') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return
    return handleAiAnalysis(req, res, user)
  }

  if (req.query.mintTime === 'detect') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const user = await requireUser(req, res)
    if (!user) return
    return detectMintTime(req, res, user)
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:etherscan:${user.id}`, 60, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.VITE_ETHERSCAN_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Etherscan key is not configured on the server' })

  const chainid = String(req.query.chainid || '1')
  const moduleName = String(req.query.module || '')
  const action = String(req.query.action || '')
  const address = String(req.query.address || '')

  if (!CHAIN_IDS.has(chainid)) return res.status(400).json({ error: 'Unsupported chain' })
  if (!ALLOWED_MODULES.has(moduleName) || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Unsupported Etherscan request' })
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: 'Invalid address' })

  const upstream = new URL(ETHERSCAN_V2)
  const allowedParams = ['chainid', 'module', 'action', 'address', 'tag', 'startblock', 'endblock', 'page', 'offset', 'sort']
  for (const key of allowedParams) {
    if (req.query[key] !== undefined) upstream.searchParams.set(key, String(req.query[key]))
  }
  upstream.searchParams.set('apikey', apiKey)

  const cacheKey = `cache:etherscan:${chainid}:${moduleName}:${action}:${address.toLowerCase()}:${upstream.searchParams.toString().replace(apiKey, 'key')}`
  const cached = await cacheGet(cacheKey)
  if (cached) return res.status(200).json(cached)

  try {
    const response = await fetch(upstream, { signal: AbortSignal.timeout(15000) })
    const data = await response.json().catch(() => null)
    if (!response.ok) return res.status(response.status).json({ error: 'Etherscan request failed' })
    await cacheSet(cacheKey, data, action === 'balance' ? 30 : 60)
    return res.status(200).json(data)
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Etherscan unavailable' })
  }
}
