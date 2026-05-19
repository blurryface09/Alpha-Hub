import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Clock, ExternalLink } from 'lucide-react'

const CHAIN_IDS = { eth: 1, base: 8453, bnb: 56 }
const EXPLORER  = { eth: 'etherscan.io', base: 'basescan.org', bnb: 'bscscan.com' }

const KNOWN_WHALES = {
  '0xd387a6e4e84a6c86bd90c158c6028a58cc8ac459': 'Pranksy',
  '0x29469395eaf6f95920e59f858042f0e28d98a20f': 'Beanie',
  '0xce90a7949bb78892f159f428d0dc23a8e3584d75': 'Cozomo',
  '0x54be3a794282c030b15e43ae2bb182e14c409c5e': 'Whale Shark',
}

function shortAddr(addr) {
  if (!addr) return ''
  const known = KNOWN_WHALES[addr.toLowerCase()]
  if (known) return known
  return addr.slice(0, 10) + '...' + addr.slice(-4)
}

function convictionFromFlipRatio(flipRatio, mintCount) {
  if (mintCount === 0) return { label: 'No Data',       explainer: '',                              color: 'text-muted',   bar: 'bg-muted',    pct: 0 }
  if (flipRatio <= 0.20) return { label: 'Diamond Hands', explainer: 'Holds most mints long-term',    color: 'text-green',   bar: 'bg-green',    pct: Math.round((1 - flipRatio) * 100) }
  if (flipRatio <= 0.50) return { label: 'Smart Money',   explainer: 'Selective seller, mostly holds', color: 'text-accent',  bar: 'bg-accent',   pct: Math.round((1 - flipRatio) * 100) }
  if (flipRatio <= 0.75) return { label: 'Flipper',       explainer: 'Sells majority within 48h',      color: 'text-accent3', bar: 'bg-accent3',  pct: Math.round((1 - flipRatio) * 100) }
  return                         { label: 'Serial Jeet',  explainer: 'Dumps almost everything fast',   color: 'text-accent2', bar: 'bg-accent2',  pct: Math.round((1 - flipRatio) * 100) }
}

async function fetchWalletData(address, chain) {
  const apiKey  = import.meta.env.VITE_ETHERSCAN_API_KEY || ''
  const chainId = CHAIN_IDS[chain] || 1
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&offset=200&page=1&apikey=${apiKey}`
  const res  = await fetch(url)
  const json = await res.json()
  if (json.status !== '1' || !Array.isArray(json.result)) return null
  return json.result
}

function classifyTx(tx, addr) {
  if (tx.input === '0x') return 'transfer'
  if (/sell|transfer|safeTransfer/i.test(tx.functionName || '')) return 'sale'
  if (parseFloat(tx.value) > 0 && tx.to?.toLowerCase() !== addr) return 'mint'
  return 'other'
}

function analyzeTransactions(txs, address) {
  const addr     = address.toLowerCase()
  const outgoing = txs.filter(tx => tx.from.toLowerCase() === addr && tx.isError === '0')

  const mintTxs     = outgoing.filter(tx => classifyTx(tx, addr) === 'mint')
  const saleTxs     = outgoing.filter(tx => classifyTx(tx, addr) === 'sale')
  const transferTxs = outgoing.filter(tx => classifyTx(tx, addr) === 'transfer')

  const uniqueContracts = new Set(outgoing.filter(tx => tx.input !== '0x').map(tx => tx.to))

  const WINDOW_48H = 48 * 3600
  let flips = 0
  mintTxs.forEach(mint => {
    const mintTime = parseInt(mint.timeStamp)
    const hasFlip  = outgoing.some(tx =>
      tx.to.toLowerCase() === mint.to.toLowerCase() &&
      tx.hash !== mint.hash &&
      parseInt(tx.timeStamp) > mintTime &&
      parseInt(tx.timeStamp) - mintTime <= WINDOW_48H
    )
    if (hasFlip) flips++
  })

  const flipRatio   = mintTxs.length > 0 ? flips / mintTxs.length : 0
  const totalEthOut = outgoing.reduce((sum, tx) => sum + parseFloat(tx.value) / 1e18, 0)
  const avgEth      = outgoing.length > 0 ? totalEthOut / outgoing.length : 0

  const mintEthTotal = mintTxs.reduce((sum, tx) => sum + parseFloat(tx.value) / 1e18, 0)
  const avgMintEth   = mintTxs.length > 0 ? mintEthTotal / mintTxs.length : 0

  const timestamps  = txs.map(tx => parseInt(tx.timeStamp))
  const firstActive = timestamps.length > 0 ? Math.min(...timestamps) : null

  const signals = []
  if (mintTxs.length >= 5)                   signals.push(`Minted ${mintTxs.length} projects on-chain`)
  if (uniqueContracts.size >= 3)             signals.push(`Interacted with ${uniqueContracts.size} unique contracts`)
  if (flipRatio < 0.2 && mintTxs.length >= 3) signals.push('Consistent holder pattern')
  if (flipRatio > 0.7)                       signals.push('High flip rate -- watch carefully')
  if (parseFloat(mintTxs[0]?.value || 0) / 1e18 > 0.5) signals.push('Large mint detected recently')
  if (avgMintEth < 0.05 && mintTxs.length > 10) signals.push('Early mover -- frequently mints in first wave')
  if (avgMintEth > 0.1)                      signals.push(`High conviction -- avg mint size ${avgMintEth.toFixed(3)} ETH`)
  if (flipRatio > 0.6)                       signals.push(`Serial jeet -- sells ${Math.round(flipRatio * 100)}% within 48h`)
  if (flipRatio < 0.1 && mintTxs.length > 5) signals.push('Long holder -- rarely seen selling')

  return {
    totalTxs: txs.length,
    uniqueContracts: uniqueContracts.size,
    mintCount: mintTxs.length,
    saleCount: saleTxs.length,
    transferCount: transferTxs.length,
    avgEth,
    avgMintEth,
    flipRatio,
    firstActive,
    recentMints: mintTxs.slice(0, 5),
    signals: signals.slice(0, 4),
  }
}

export default function WalletIntelPanel({ address, chain = 'eth', label }) {
  const navigate = useNavigate()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!address) return
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchWalletData(address, chain)
      .then(txs => {
        if (cancelled) return
        if (!txs) { setError('No on-chain data returned'); setLoading(false); return }
        setData(analyzeTransactions(txs, address))
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) { setError('Could not reach Etherscan API'); setLoading(false) }
      })

    return () => { cancelled = true }
  }, [address, chain])

  const conviction  = data ? convictionFromFlipRatio(data.flipRatio, data.mintCount) : null
  const explorerUrl = `https://${EXPLORER[chain] || EXPLORER.eth}/address/${address}`
  const knownName   = KNOWN_WHALES[address?.toLowerCase()]

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Activity size={13} className="text-accent" />
        <span className="text-xs font-semibold truncate min-w-0">{label || shortAddr(address)}</span>
        {knownName && (
          <span className="badge badge-green text-[10px] flex-shrink-0">Known Whale</span>
        )}
        <span className={`badge text-[10px] flex-shrink-0 ${chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
          {chain.toUpperCase()}
        </span>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-muted hover:text-accent transition-colors"
        >
          <ExternalLink size={11} />
        </a>
      </div>

      {loading ? (
        <div className="space-y-2 py-1">
          {[0, 1, 2].map(i => (
            <div key={i} className="animate-pulse bg-surface2 rounded h-4" />
          ))}
        </div>
      ) : error ? (
        <p className="text-xs text-muted2 italic">{error}</p>
      ) : (
        <>
          {/* Conviction bar */}
          <div className="bg-surface2 rounded-lg p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-muted uppercase tracking-wider font-mono">Conviction</span>
              <span className={`text-xs font-bold ${conviction.color}`}>{conviction.label}</span>
            </div>
            <div className="h-1.5 bg-bg rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${conviction.bar}`}
                style={{ width: `${conviction.pct}%` }}
              />
            </div>
            {conviction.explainer && (
              <div className="text-[10px] text-muted2 mt-0.5 italic">{conviction.explainer}</div>
            )}
            <div className="text-[10px] text-muted2 mt-1">
              {data.mintCount > 0
                ? `${Math.round(data.flipRatio * 100)}% sold within 48h of mint`
                : 'No mint activity found in last 200 txs'}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-surface2 rounded-lg p-2 text-center">
              <div className="text-sm font-bold text-text">{data.totalTxs}</div>
              <div className="text-[10px] text-muted font-mono">Total Txs</div>
            </div>
            <div className="bg-surface2 rounded-lg p-2 text-center">
              <div className="text-sm font-bold text-accent">{data.uniqueContracts}</div>
              <div className="text-[10px] text-muted font-mono">Contracts</div>
            </div>
            <div className="bg-surface2 rounded-lg p-2 text-center">
              <div className="text-sm font-bold text-green">{data.avgEth.toFixed(3)}</div>
              <div className="text-[10px] text-muted font-mono">Avg ETH</div>
            </div>
          </div>

          {/* First active */}
          {data.firstActive && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted2">
              <Clock size={10} />
              First active: {new Date(data.firstActive * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
            </div>
          )}

          {/* Empty states */}
          {data.totalTxs === 0 && (
            <p className="text-[10px] text-muted2 italic">
              No activity found on {chain.toUpperCase()}. Try switching chain.
            </p>
          )}
          {data.mintCount === 0 && data.totalTxs > 0 && (
            <p className="text-[10px] text-muted2 italic">
              Wallet active but no mint activity detected
            </p>
          )}

          {/* Signals */}
          {data.signals.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted uppercase tracking-wider font-mono">Signals</div>
              {data.signals.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs text-text">
                  <div className="w-1 h-1 rounded-full bg-accent flex-shrink-0" />
                  {s}
                </div>
              ))}
            </div>
          )}

          {/* Last 5 mints */}
          {data.recentMints.length > 0 && (
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider font-mono mb-1.5">Last mints</div>
              <div className="space-y-1">
                {data.recentMints.filter(tx => tx.to && tx.to.length === 42 && !tx.to.match(/^0x0{10,}/)).map((tx, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <div className="w-1.5 h-1.5 rounded-full bg-green flex-shrink-0" />
                    <span className="font-mono text-muted max-w-[120px] truncate">
                      {tx.to.slice(0, 12)}...
                    </span>
                    <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                      {parseFloat(tx.value) > 0 && (
                        <span className="text-green text-right font-mono">
                          {(parseFloat(tx.value) / 1e18).toFixed(3)} ETH
                        </span>
                      )}
                      <button
                        onClick={() => navigate(`/mintguard?contract=${tx.to}&chain=${chain}`)}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors"
                      >
                        + Track
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
