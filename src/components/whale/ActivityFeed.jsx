import React from 'react'
import { Zap, ArrowRight, Activity, ExternalLink } from 'lucide-react'

function timeAgo(ts) {
  if (!ts) return '—'
  const now = Date.now()
  const time = new Date(ts).getTime()
  const diff = Math.floor((now - time) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

const EXPLORER = {
  eth: 'etherscan.io',
  base: 'basescan.org',
  bnb: 'bscscan.com',
}

const CHAIN_SYMBOL = {
  eth: 'ETH',
  base: 'ETH',
  bnb: 'BNB',
}

export default function ActivityFeed({ activity }) {
  if (!activity || !activity.length) {
    return (
      <div className="text-center py-10">
        <Activity size={28} className="text-muted mx-auto mb-2" />
        <p className="text-muted text-sm">No activity yet</p>
        <p className="text-xs text-muted2 mt-1">Add wallets and hit Refresh to see their moves</p>
      </div>
    )
  }

  return (
    <div className="space-y-0 max-h-[600px] overflow-y-auto">
      {activity.filter(Boolean).map((a, i) => {
        const isMint = a.is_mint
        const val = parseFloat(a.value_eth || 0)
        const isLarge = val > 0.5
        const explorer = EXPLORER[a.chain] || 'etherscan.io'
        const txUrl = a.tx_hash ? `https://${explorer}/tx/${a.tx_hash}` : null

        return (
          <div
            key={a.id || a.tx_hash || i}
            className={`py-3 px-2 border-b border-border last:border-0 rounded-lg mb-0.5 ${
              isMint ? 'bg-green/5 border-green/10' : isLarge ? 'bg-accent/3' : ''
            }`}
          >
            <div className="flex items-start gap-2.5">
              <div className={`mt-0.5 flex-shrink-0 p-1.5 rounded-lg ${
                isMint ? 'bg-green/15 text-green' : isLarge ? 'bg-accent/15 text-accent' : 'bg-surface2 text-muted'
              }`}>
                {isMint ? <Zap size={11} /> : <ArrowRight size={11} />}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-semibold truncate max-w-28">
                    {a.wallet_label && a.wallet_label !== 'Unlabeled'
                      ? a.wallet_label
                      : a.wallet_address?.slice(0, 8) + '...' + a.wallet_address?.slice(-4)}
                  </span>
                  {isMint && <span className="badge badge-green text-[10px]">🟢 MINT</span>}
                  {isLarge && !isMint && <span className="badge badge-cyan text-[10px]">LARGE</span>}
                  <span className={`badge text-[10px] ${a.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
                    {(a.chain || 'eth').toUpperCase()}
                  </span>
                </div>

                <div className="text-xs text-muted mt-0.5">
                  {a.method_name || a.action_type || 'Transfer'}
                  {a.contract_address && (
                    <span className="ml-1 text-muted2">
                      → {a.contract_name || a.contract_address?.slice(0, 8) + '...'}
                    </span>
                  )}
                </div>

                {txUrl && (
                  <a
                    href={txUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-accent hover:underline flex items-center gap-1 mt-0.5"
                  >
                    View tx <ExternalLink size={9} />
                  </a>
                )}
              </div>

              <div className="text-right flex-shrink-0">
                <div className={`text-sm font-mono font-semibold ${
                  isMint ? 'text-green' : isLarge ? 'text-accent' : 'text-text'
                }`}>
                  {val > 0 ? val.toFixed(4) : '—'} {CHAIN_SYMBOL[a.chain] || 'ETH'}
                </div>
                <div className="text-[10px] text-muted mt-0.5">
                  {timeAgo(a.timestamp || a.created_at)}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
