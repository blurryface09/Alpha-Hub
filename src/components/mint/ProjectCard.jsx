import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Zap, Trash2, Clock, ChevronDown, ChevronUp, ToggleLeft, ToggleRight, ExternalLink } from 'lucide-react'

const STATUS_STYLES = {
  upcoming: { dot: 'dot-warning', badge: 'badge-yellow', label: 'UPCOMING' },
  live:     { dot: 'dot-live',    badge: 'badge-green',  label: 'LIVE NOW' },
  minted:   { dot: 'dot-dead',    badge: 'badge-cyan',   label: 'MINTED' },
  missed:   { dot: 'dot-dead',    badge: 'badge-red',    label: 'MISSED' },
  cancelled:{ dot: 'dot-dead',    badge: 'badge-red',    label: 'CANCELLED' },
}

const WL_BADGE = {
  GTD:     'badge-green',
  FCFS:    'badge-yellow',
  RAFFLE:  'badge-purple',
  UNKNOWN: 'badge-cyan',
}

function Countdown({ mintDate }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    const update = () => {
      const diff = new Date(mintDate) - new Date()
      if (diff <= 0) { setTimeLeft('LIVE NOW'); return }
      const d = Math.floor(diff / 86400000)
      const h = Math.floor((diff % 86400000) / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      if (d > 0) setTimeLeft(`${d}d ${h}h ${m}m`)
      else if (h > 0) setTimeLeft(`${h}h ${m}m ${s}s`)
      else setTimeLeft(`${m}m ${s}s`)
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [mintDate])

  return (
    <span className="font-mono text-xs text-accent3">{timeLeft}</span>
  )
}

export default function ProjectCard({ project, isMinting, onMint, onDelete, onStatusUpdate, onMintModeToggle }) {
  const [expanded, setExpanded] = useState(false)
  const status = STATUS_STYLES[project.status] || STATUS_STYLES.upcoming

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={`card border transition-all ${
        project.status === 'live' ? 'border-green/30 bg-green/3 glow-green' :
        project.status === 'minted' ? 'border-accent/20' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Status dot */}
        <div className="mt-1.5 flex-shrink-0">
          <div className={status.dot} />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{project.name}</span>
                <span className={`badge ${status.badge} text-[10px]`}>{status.label}</span>
                <span className={`badge ${WL_BADGE[project.wl_type]} text-[10px]`}>{project.wl_type}</span>
                <span className={`badge text-[10px] ${project.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
                  {project.chain.toUpperCase()}
                </span>
              </div>

              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                {project.mint_date && (
                  <div className="flex items-center gap-1.5">
                    <Clock size={11} className="text-muted" />
                    {project.status === 'upcoming' ? (
                      <Countdown mintDate={project.mint_date} />
                    ) : (
                      <span className="font-mono text-xs text-muted">
                        {new Date(project.mint_date).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                )}
                {project.mint_price && (
                  <span className="text-xs text-muted">{project.mint_price}</span>
                )}
                {project.max_mint > 1 && (
                  <span className="text-xs text-muted">max {project.max_mint}</span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Mint mode toggle */}
              <button
                onClick={onMintModeToggle}
                className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-all ${
                  project.mint_mode === 'auto'
                    ? 'border-green/40 text-green bg-green/8'
                    : 'border-border2 text-muted hover:border-accent hover:text-accent'
                }`}
              >
                {project.mint_mode === 'auto' ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
                {project.mint_mode === 'auto' ? 'Auto' : 'Confirm'}
              </button>

              {/* Mint button */}
              {(project.status === 'live' || project.status === 'upcoming') && project.contract_address && (
                <button
                  onClick={onMint}
                  disabled={isMinting}
                  className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5"
                >
                  {isMinting ? <div className="spinner w-3 h-3" /> : <Zap size={12} />}
                  {isMinting ? 'Minting...' : 'Mint'}
                </button>
              )}

              <button
                onClick={() => setExpanded(!expanded)}
                className="text-muted hover:text-text p-1"
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mt-3 pt-3 border-t border-border space-y-2"
        >
          {project.contract_address && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Contract</span>
              <span className="font-mono text-accent">{project.contract_address.slice(0, 16)}...{project.contract_address.slice(-6)}</span>
            </div>
          )}
          {project.source_url && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Source</span>
              <a href={project.source_url} target="_blank" rel="noopener noreferrer" className="text-accent flex items-center gap-1 hover:underline">
                View <ExternalLink size={10} />
              </a>
            </div>
          )}
          {project.gas_limit && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Gas limit</span>
              <span className="font-mono">{project.gas_limit.toLocaleString()}</span>
            </div>
          )}
          {project.notes && (
            <div className="text-xs text-muted bg-surface2 rounded-lg p-2">{project.notes}</div>
          )}

          {/* Status controls */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <span className="text-xs text-muted">Set status:</span>
            {['upcoming', 'live', 'minted', 'missed', 'cancelled'].map(s => (
              <button
                key={s}
                onClick={() => onStatusUpdate(s)}
                className={`text-xs px-2 py-0.5 rounded border transition-all ${
                  project.status === s ? 'border-accent text-accent' : 'border-border text-muted hover:border-border2'
                }`}
              >
                {s}
              </button>
            ))}
            <button onClick={onDelete} className="btn-danger ml-auto text-xs px-2 py-0.5">
              <Trash2 size={11} />
            </button>
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}
