import React, { useEffect, useState } from 'react'
import { Activity, Clock, ExternalLink } from 'lucide-react'

const CHAIN_IDS = { eth: 1, base: 8453, bnb: 56 }
const EXPLORER  = { eth: 'etherscan.io', base: 'basescan.org', bnb: 'bscscan.com' }

function shortAddr(addr) {
if (!addr) return ''
return addr.slice(0, 10) + '...' + addr.slice(-4)
}

function convictionFromFlipRatio(flipRatio, mintCount) {
if (mintCount === 0) return { label: 'No Data',       color: 'text-muted',   bar: 'bg-muted',    pct: 0 }
if (flipRatio <= 0.20) return { label: 'Diamond Hands', color: 'text-green',   bar: 'bg-green',    pct: Math.round((1 - flipRatio) * 100) }
if (flipRatio <= 0.50) return { label: 'Smart Money',   color: 'text-accent',  bar: 'bg-accent',   pct: Math.round((1 - flipRatio) * 100) }
if (flipRatio <= 0.75) return { label: 'Flipper',       color: 'text-accent3', bar: 'bg-accent3',  pct: Math.round((1 - flipRatio) * 100) }
return                         { label: 'Serial Jeet',  color: 'text-accent2', bar: 'bg-accent2',  pct: Math.round((1 - flipRatio) * 100) }
}

async function fetchWalletData(address, chain) {
const apiKey  = import.meta.env.VITE_ETHERSCAN_API_KEY || ''
const chainId = CHAIN_IDS[chain] || 1
const url = 'https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&offset=200&page=1&apikey=${apiKey}'
const res  = await fetch(url)
const json = await res.json()
if (json.status !== '1' || !Array.isArray(json.result)) return null
return json.result
}

function analyzeTransactions(txs, address) {
const addr     = address.toLowerCase()
const outgoing = txs.filter(tx => tx.from.toLowerCase() === addr && tx.isError === '0')

const mintTxs = outgoing.filter(tx =>
tx.input !== '0x' &&
tx.to !== addr &&
tx.to && tx.to.length === 42 && !tx.to.match(/^0x0{10,}/) &&
(parseFloat(tx.value) > 0 || /mint|buy|claim/i.test(tx.functionName || ''))
)

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

const flipRatio  = mintTxs.length > 0 ? flips / mintTxs.length : 0
const totalEthOut = outgoing.reduce((sum, tx) => sum + parseFloat(tx.value) / 1e18, 0)
const avgEth      = outgoing.length > 0 ? totalEthOut / outgoing.length : 0

const timestamps  = txs.map(tx => parseInt(tx.timeStamp))
const firstActive = timestamps.length > 0 ? Math.min(...timestamps) : null

const signals = []
if (mintTxs.length >= 5)              signals.push('Minted ${mintTxs.length} projects on-chain')
if (uniqueContracts.size >= 3)        signals.push('Interacted with ${uniqueContracts.size} unique contracts')
if (flipRatio < 0.2 && mintTxs.length >= 3) signals.push('Consistent holder pattern')
if (flipRatio > 0.7)                  signals.push('High flip rate -- watch carefully')
if (parseFloat(mintTxs[0]?.value || 0) / 1e18 > 0.5) signals.push('Large mint detected recently')

return {
totalTxs: txs.length,
uniqueContracts: uniqueContracts.size,
mintCount: mintTxs.length,
avgEth,
flipRatio,
firstActive,
recentMints: mintTxs.slice(0, 5),
signals: signals.slice(0, 3),
}
}

export default function WalletIntelPanel({ address, chain = 'eth', label }) {
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
const explorerUrl = 'https://${EXPLORER[chain] || EXPLORER.eth}/address/${address}'

return (
<div className="space-y-3">
{/* Header */}
<div className="flex items-center gap-2">
<Activity size={13} className="text-accent" />
<span className="text-xs font-semibold truncate">{label || shortAddr(address)}</span>
<span className={'badge text-[10px] ${chain === 'eth' ? 'badge-purple' : 'badge-cyan'}'}>
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
    <div className="flex items-center gap-2 py-3 text-muted text-xs">
      <div className="spinner w-3 h-3" />
      Analyzing on-chain activity...
    </div>
  ) : error ? (
    <p className="text-xs text-muted2 italic">{error}</p>
  ) : (
    <>
      {/* Conviction bar */}
      <div className="bg-surface2 rounded-lg p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-muted uppercase tracking-wider font-mono">Conviction</span>
          <span className={'text-xs font-bold ${conviction.color}'}>{conviction.label}</span>
        </div>
        <div className="h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className={'h-full rounded-full transition-all ${conviction.bar}'}
            style={{ width: '${conviction.pct}%' }}
          />
        </div>
        <div className="text-[10px] text-muted2 mt-1">
          {data.mintCount > 0
            ? '${Math.round(data.flipRatio * 100)}% sold within 48h of mint'
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
                <span className="font-mono text-muted truncate">
                  {tx.to.slice(0, 12)}...
                </span>
                {parseFloat(tx.value) > 0 && (
                  <span className="text-green ml-auto flex-shrink-0 font-mono">
                    {(parseFloat(tx.value) / 1e18).toFixed(3)} ETH
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.totalTxs === 0 && (
        <p className="text-[10px] text-muted2 italic">
          No transaction history found on {chain.toUpperCase()}.
        </p>
      )}
    </>
  )}
</div>
)
}
