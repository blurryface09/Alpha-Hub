import { requireUser } from './_lib/auth.js'

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api'
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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

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

  try {
    const response = await fetch(upstream, { signal: AbortSignal.timeout(15000) })
    const data = await response.json().catch(() => null)
    if (!response.ok) return res.status(response.status).json({ error: 'Etherscan request failed' })
    return res.status(200).json(data)
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Etherscan unavailable' })
  }
}
