import React, { useState, useEffect, useRef } from 'react'
import { Activity, RefreshCw, ExternalLink, Zap } from 'lucide-react'
import { CHAINS } from '../../lib/blockchain'
import { getAuthToken } from '../../lib/supabase'

const EXPLORER = {
  eth: 'etherscan.io',
  base: 'basescan.org',
  bnb: 'bscscan.com',
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (diff < 60) return diff + 's ago'
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
  return Math.floor(diff / 3600) + 'h ago'
}

function jeetColor(score) {
  if (score >= 75) return 'text-red-400'
  if (score >= 50) return 'text-yellow-400'
  if (score >= 25) return 'text-text'
  return 'text-green'
}

function jeetLabel(score) {
  if (score >= 75) return 'Jeet'
  if (score >= 50) return 'Flipper'
  if (score >= 25) return 'Mixed'
  return 'Diamond'
}

async function fetchContractMints(contractAddress, chainKey) {
  const chain = CHAINS[chainKey]
  if (!chain || !contractAddress) return []
  try {
    const token = await getAuthToken()
    if (!token) return []
    const url = new URL('/api/etherscan', window.location.origin)
    url.searchParams.set('chainid', chain.id)
    url.searchParams.set('module', 'account')
    url.searchParams.set('action', 'txlist')
    url.searchParams.set('address', contractAddress)
    url.searchParams.set('startblock', '0')
    url.searchParams.set('endblock', '99999999')
    url.searchParams.set('sort', 'desc')
    url.searchParams.set('page', '1')
    url.searchParams.set('offset', '50')
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const d = await r.json()
    if (d.status !== '1' || !Array.isArray(d.result)) return []
    // Filter to only mint transactions (to the contract)
    return d.result.filter(tx =>
      tx.to?.toLowerCase() === contractAddress.toLowerCase() &&
      tx.isError === '0' &&
      tx.input && tx.input !== '0x'
    ).slice(0, 30)
  } catch(e) {
    console.error('fetchContractMints error:', e)
    return []
  }
}

async function fetchJeetScore(walletAddress, chainKey) {
  const chain = CHAINS[chainKey]
  if (!chain) return 50
  try {
    const token = await getAuthToken()
    if (!token) return 50
    const url = new URL('/api/etherscan', window.location.origin)
    url.searchParams.set('chainid', chain.id)
    url.searchParams.set('module', 'account')
    url.searchParams.set('action', 'txlist')
    url.searchParams.set('address', walletAddress)
    url.searchParams.set('startblock', '0')
    url.searchParams.set('endblock', '99999999')
    url.searchParams.set('sort', 'desc')
    url.searchParams.set('page', '1')
    url.searchParams.set('offset', '100')
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const d = await r.json()
    if (d.status !== '1' || !Array.isArray(d.result)) return 50
    const txs = d.result
    const total = txs.length
    if (total === 0) return 50
    // Quick flip detection - txs within 48 hours of each other
    let quickFlips = 0
    for (let i = 0; i < txs.length - 1; i++) {
      const diff = Math.abs(parseInt(txs[i].timeStamp) - parseInt(txs[i+1].timeStamp))
      if (diff < 172800) quickFlips++ // 48 hours
    }
    const score = Math.min(100, Math.round((quickFlips / Math.max(total, 1)) * 100))
    return score
  } catch {
    return 50
  }
}

export default function LiveMintFeed({ project }) {
  const [mints, setMints] = useState([])
  const [loading, setLoading] = useState(false)
  const [jeetScores, setJeetScores] = useState({})
  const [lastRefresh, setLastRefresh] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const intervalRef = useRef(null)

  const fetchMints = async () => {
    if (!project.contract_address) return
    setLoading(true)
    try {
      const txs = await fetchContractMints(project.contract_address, project.chain || 'eth')
      setMints(txs)
      setLastRefresh(new Date())
      // Fetch jeet scores for unique wallets in background
      const unique = [...new Set(txs.map(t => t.from))]
      for (const wallet of unique.slice(0, 10)) {
        fetchJeetScore(wallet, project.chain || 'eth').then(score => {
          setJeetScores(prev => ({ ...prev, [wallet.toLowerCase()]: score }))
        })
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchMints, 30000)
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [autoRefresh, project.contract_address])

  if (!project.contract_address) {
    return (
      <div className="text-center py-4 text-muted text-xs">
        Add a contract address to this project to enable live mint tracking
      </div>
    )
  }

  const explorer = EXPLORER[project.chain] || 'etherscan.io'
  const chainId = CHAINS[project.chain]?.id || 1

  // Stats
  const uniqueMinters = new Set(mints.map(t => t.from)).size
  const avgJeet = mints.length > 0
    ? Math.round(Object.values(jeetScores).reduce((a, b) => a + b, 0) / Math.max(Object.values(jeetScores).length, 1))
    : null
  const jeetCount = Object.values(jeetScores).filter(s => s >= 75).length
  const diamondCount = Object.values(jeetScores).filter(s => s < 25).length

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={12} className="text-accent" />
          <span className="text-xs font-mono text-muted uppercase tracking-wider">Live Mint Feed</span>
          {autoRefresh && <span className="text-[10px] text-green animate-pulse">LIVE</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={"text-[10px] px-2 py-0.5 rounded border transition-all " + (autoRefresh ? 'border-green text-green bg-green/8' : 'border-border text-muted')}
          >
            {autoRefresh ? 'Auto ON' : 'Auto OFF'}
          </button>
          <button
            onClick={fetchMints}
            disabled={loading}
            className="btn-ghost text-xs px-2 py-1 flex items-center gap-1"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {mints.length === 0 ? 'Load' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      {mints.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Mints', val: mints.length },
            { label: 'Wallets', val: uniqueMinters },
            { label: 'Jeets', val: jeetCount, color: 'text-accent2' },
            { label: 'Diamonds', val: diamondCount, color: 'text-green' },
          ].map(s => (
            <div key={s.label} className="bg-surface2 rounded-lg p-2 text-center">
              <div className={"text-sm font-bold " + (s.color || 'text-text')}>{s.val}</div>
              <div className="text-[10px] text-muted">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Feed */}
      {mints.length === 0 && !loading && (
        <div className="text-center py-6 text-muted text-xs">
          Click Load to fetch recent mints from this contract
        </div>
      )}

      {loading && mints.length === 0 && (
        <div className="flex items-center justify-center py-6 gap-2 text-muted text-xs">
          <div className="spinner w-3 h-3" />
          Fetching mints...
        </div>
      )}

      <div className="space-y-1 max-h-64 overflow-y-auto">
        {mints.map((tx, i) => {
          const score = jeetScores[tx.from?.toLowerCase()]
          const val = tx.value ? (parseInt(tx.value) / 1e18).toFixed(4) : '0'
          const ts = tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString() : null
          const txUrl = `https://${explorer}/tx/${tx.hash}`
          const walletUrl = `https://${explorer}/address/${tx.from}`

          return (
            <div key={tx.hash || i} className="flex items-center gap-2 py-2 px-2 bg-surface2 rounded-lg">
              {/* Jeet indicator */}
              <div className={"w-1.5 h-8 rounded-full flex-shrink-0 " + (
                score === undefined ? 'bg-muted' :
                score >= 75 ? 'bg-red-400' :
                score >= 50 ? 'bg-yellow-400' :
                score >= 25 ? 'bg-text' : 'bg-green'
              )} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <a href={walletUrl} target="_blank" rel="noreferrer"
                    className="text-xs font-mono text-accent hover:underline truncate max-w-28">
                    {tx.from?.slice(0, 6)}...{tx.from?.slice(-4)}
                  </a>
                  {score !== undefined && (
                    <span className={"text-[10px] font-mono " + jeetColor(score)}>
                      {jeetLabel(score)} ({score})
                    </span>
                  )}
                  {score === undefined && (
                    <span className="text-[10px] text-muted">analyzing...</span>
                  )}
                </div>
                <div className="text-[10px] text-muted">{ts ? timeAgo(ts) : '--'}</div>
              </div>

              <div className="text-right flex-shrink-0">
                <div className="text-xs font-mono text-text">{val} ETH</div>
                <a href={txUrl} target="_blank" rel="noreferrer"
                  className="text-[10px] text-accent hover:underline flex items-center gap-0.5 justify-end">
                  tx <ExternalLink size={8} />
                </a>
              </div>
            </div>
          )
        })}
      </div>

      {lastRefresh && (
        <div className="text-[10px] text-muted text-right">
          Last updated: {lastRefresh.toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}
