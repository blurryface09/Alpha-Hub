import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, X, Radar } from 'lucide-react'
import { Link } from 'react-router-dom'

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function shortAddr(addr) {
  if (!addr) return ''
  return addr.slice(0, 10) + '…' + addr.slice(-4)
}

const STRENGTH_META = {
  1: { label: 'Watch',  cls: 'border-amber-500/30 text-amber-300 bg-amber-500/10',  dot: 'bg-amber-400' },
  2: { label: 'Strong', cls: 'border-orange-500/30 text-orange-300 bg-orange-500/10', dot: 'bg-orange-400' },
  3: { label: 'HOT',    cls: 'border-green/30 text-green bg-green/10 animate-pulse', dot: 'bg-green animate-pulse' },
}

function SignalCard({ signal, onCopyMint, onIgnore }) {
  const meta  = STRENGTH_META[Math.min(signal.signal_strength, 3)]
  const count = signal.wallets.length

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18 }}
      className="bg-surface2 border border-border rounded-xl p-3 flex flex-col gap-2"
    >
      {/* Top row: strength + contract + ignore */}
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-bold px-2 py-1 rounded border font-mono ${meta.cls}`}>
          {meta.label}
        </span>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
        <span className="font-mono text-xs text-text truncate flex-1" title={signal.contract_address}>
          {shortAddr(signal.contract_address)}
        </span>
        <span className={`badge text-[10px] ${signal.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
          {signal.chain.toUpperCase()}
        </span>
        <button
          onClick={() => onIgnore(signal.contract_address)}
          className="text-muted hover:text-text transition-colors p-0.5 flex-shrink-0"
          title="Ignore"
        >
          <X size={12} />
        </button>
      </div>

      {/* Wallet line */}
      <div className="text-xs text-muted leading-relaxed">
        <span className="text-text font-medium">
          {count} {count === 1 ? 'wallet' : 'wallets'} entered
        </span>
        {' — '}
        {signal.wallets.map((w, i) => (
          <span key={i}>
            {i > 0 && ', '}
            <span className="text-accent font-mono">{w.label || shortAddr(w.address)}</span>
          </span>
        ))}
      </div>

      {/* Meta row: ETH + time */}
      <div className="flex items-center gap-3 text-[10px] text-muted2 font-mono">
        {signal.total_eth > 0 && (
          <span className="text-green">{signal.total_eth.toFixed(3)} ETH</span>
        )}
        <span>{timeAgo(signal.first_mint_at)}</span>
      </div>

      {/* Action */}
      <button
        onClick={() => onCopyMint(signal)}
        className="btn-primary text-xs flex items-center justify-center gap-1.5 mt-0.5 min-h-[44px]"
      >
        <Zap size={12} />
        Copy Mint
      </button>
    </motion.div>
  )
}

export default function CopyMintSignal({ signals, onCopyMint }) {
  const [ignored, setIgnored] = useState(new Set())

  const visible = (signals || []).filter(s => !ignored.has(s.contract_address))

  const ignore = (contractAddress) =>
    setIgnored(prev => new Set([...prev, contractAddress]))

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Radar size={14} className="text-accent" />
        <span className="section-label mb-0">Copy Mint Signals</span>
        {visible.length > 0 && (
          <span className="badge badge-green text-[10px]">{visible.length} active</span>
        )}
      </div>

      <AnimatePresence mode="popLayout">
        {visible.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-xs text-muted2 bg-surface2 rounded-xl border border-border px-4 py-5 text-center"
          >
            <Radar size={18} className="text-muted2 mx-auto mb-2" />
            <p className="font-medium text-text text-sm mb-1">No signals right now</p>
            <p className="text-[11px] leading-relaxed">
              Signals appear when watched wallets mint. Add wallets in{' '}
              <Link to="/whaleradar" className="text-accent hover:underline">WhaleRadar</Link>.
            </p>
          </motion.div>
        ) : (
          visible.map(signal => (
            <SignalCard
              key={signal.contract_address}
              signal={signal}
              onCopyMint={onCopyMint}
              onIgnore={ignore}
            />
          ))
        )}
      </AnimatePresence>
    </section>
  )
}
