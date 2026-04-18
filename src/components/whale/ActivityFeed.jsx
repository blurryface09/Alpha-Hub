import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, ArrowRight, Activity } from 'lucide-react'

export default function ActivityFeed({ activity }) {
  if (!activity.length) {
    return (
      <div className="text-center py-10">
        <Activity size={28} className="text-muted mx-auto mb-2" />
        <p className="text-muted text-sm">No activity yet</p>
        <p className="text-xs text-muted2 mt-1">Add wallets to your watchlist to start tracking</p>
      </div>
    )
  }

  return (
    <div className="space-y-0 max-h-[500px] overflow-y-auto">
      <AnimatePresence initial={false}>
        {activity.map((a, i) => {
          const isMint = a.is_mint
          const isLarge = parseFloat(a.value_eth) > 1
          const aiSummary = a.raw_data?.ai_summary

          return (
            <motion.div
              key={a.id || i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.02 }}
              className={`py-3 border-b border-border last:border-0 ${
                isMint ? 'bg-green/3' : isLarge ? 'bg-accent/3' : ''
              }`}
            >
              <div className="flex items-start gap-2.5">
                {/* Icon */}
                <div className={`mt-0.5 flex-shrink-0 p-1.5 rounded-lg ${
                  isMint ? 'bg-green/15 text-green' : isLarge ? 'bg-accent/15 text-accent' : 'bg-surface2 text-muted'
                }`}>
                  {isMint ? <Zap size={11} /> : <ArrowRight size={11} />}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {a.wallet_label || a.wallet_address?.slice(0, 12) + '...'}
                    </span>
                    {isMint && <span className="badge badge-green text-[10px]">MINT</span>}
                    {isLarge && !isMint && <span className="badge badge-cyan text-[10px]">LARGE</span>}
                    <span className={`badge text-[10px] ${a.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
                      {a.chain?.toUpperCase()}
                    </span>
                  </div>

                  <div className="text-xs text-muted mt-0.5 truncate">
                    {a.method_name || a.action_type}
                    {a.contract_address && ` → ${a.contract_address.slice(0, 10)}...`}
                  </div>

                  {aiSummary && (
                    <div className="text-xs text-text/70 mt-1 leading-relaxed bg-surface2 rounded-lg px-2.5 py-1.5 border border-border">
                      {aiSummary}
                    </div>
                  )}
                </div>

                {/* Value + time */}
                <div className="text-right flex-shrink-0">
                  <div className={`text-sm font-mono font-medium ${
                    isMint ? 'text-green' : isLarge ? 'text-accent' : 'text-text'
                  }`}>
                    {parseFloat(a.value_eth || 0).toFixed(3)} ETH
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">
                    {a.timestamp ? new Date(a.timestamp).toLocaleTimeString() : ''}
                  </div>
                </div>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
