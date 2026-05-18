import React, { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, RefreshCw, CheckCircle, XCircle, Clock, Zap, AlertTriangle, Cpu } from 'lucide-react'
import { getAuthToken } from '../../lib/supabase'

// ─── Phase display config ─────────────────────────────────────────────────────

const PHASE_CONFIG = {
  sim_start:            { icon: Zap,           color: 'text-cyan-300' },
  start:                { icon: Zap,           color: 'text-cyan-300' },
  wallet:               { icon: Cpu,           color: 'text-blue-300' },
  gas:                  { icon: Cpu,           color: 'text-purple-300' },
  gas_failed:           { icon: XCircle,       color: 'text-red-400' },
  gas_escalation:       { icon: AlertTriangle, color: 'text-amber-400' },
  timing:               { icon: Clock,         color: 'text-amber-300' },
  prepare:              { icon: Cpu,           color: 'text-blue-300' },
  execute:              { icon: Zap,           color: 'text-cyan-300' },
  retry:                { icon: RefreshCw,     color: 'text-amber-400' },
  nonce_refresh:        { icon: RefreshCw,     color: 'text-amber-300' },
  success:              { icon: CheckCircle,   color: 'text-green-400' },
  simulated_success:    { icon: CheckCircle,   color: 'text-green-400' },
  failed:               { icon: XCircle,       color: 'text-red-400' },
  simulated_failure:    { icon: XCircle,       color: 'text-red-400' },
  error:                { icon: XCircle,       color: 'text-red-400' },
  sim_error:            { icon: XCircle,       color: 'text-red-400' },
  armed:                { icon: Zap,           color: 'text-green-400' },
  watching:             { icon: Clock,         color: 'text-muted' },
  prewarm:              { icon: Clock,         color: 'text-amber-300' },
}

function phaseConfig(state) {
  return PHASE_CONFIG[state] ?? { icon: Clock, color: 'text-muted' }
}

function fmtTime(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return iso }
}

// ─── Event row ────────────────────────────────────────────────────────────────

function EventRow({ event, isLast }) {
  const { icon: Icon, color } = phaseConfig(event.state)
  const meta = event.metadata || {}
  const metaEntries = Object.entries(meta)
    .filter(([k]) => !['sim', 'ts', 'elapsed_ms'].includes(k))
    .slice(0, 5)

  return (
    <div className={`flex items-start gap-2.5 py-2 ${isLast ? '' : 'border-b border-border/30'}`}>
      <div className="mt-0.5 shrink-0">
        <Icon size={12} className={color} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-mono font-medium ${color}`}>{event.state}</span>
          <span className="text-[10px] text-muted">{fmtTime(event.created_at)}</span>
          {typeof meta.elapsed_ms === 'number' && (
            <span className="text-[10px] text-muted font-mono">+{meta.elapsed_ms}ms</span>
          )}
        </div>
        <p className="text-xs text-text mt-0.5 leading-relaxed">{event.message}</p>
        {metaEntries.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {metaEntries.map(([k, v]) => (
              <div key={k} className="text-[10px] font-mono text-muted/80">
                {k}:{' '}
                <span className="text-text/60">
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function StrikeReplayModal({ project, intentId, onClose, onRerun }) {
  const [loading, setLoading] = useState(true)
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [rerunning, setRerunning] = useState(false)

  useEffect(() => {
    if (!intentId) { setLoading(false); return }
    let cancelled = false

    async function fetchEvents() {
      setLoading(true)
      setError(null)
      try {
        const token = await getAuthToken()
        const res = await fetch(`/api/mint/strike-replay?intentId=${encodeURIComponent(intentId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json().catch(() => ({}))
        if (!cancelled) {
          if (data.ok) setEvents(data.events ?? [])
          else setError(data.error || 'Failed to load replay events')
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [intentId])

  async function handleRerun() {
    if (rerunning || !intentId) return
    setRerunning(true)
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/mint/strike-rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ intentId }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        onRerun?.()
        onClose()
      }
    } catch { /* ignore */ } finally {
      setRerunning(false)
    }
  }

  const lastEvent = events[events.length - 1]
  const simFailed = lastEvent?.state === 'simulated_failure' || lastEvent?.state === 'failed'
  const simPassed = lastEvent?.state === 'simulated_success' || lastEvent?.state === 'success'

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.18 }}
          className="relative z-10 bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-start justify-between px-4 py-3 border-b border-border shrink-0">
            <div>
              <h2 className="text-sm font-semibold text-text">Simulation Replay</h2>
              <p className="text-[10px] text-muted mt-0.5 truncate max-w-[280px]">
                {project?.name ?? 'Strike execution timeline'}
              </p>
              {intentId && (
                <p className="text-[10px] font-mono text-muted/60 mt-0.5 truncate max-w-[280px]">
                  {intentId}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {simPassed && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-green-500/30 text-green-400">
                  Sim passed
                </span>
              )}
              {simFailed && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-red-500/30 text-red-400">
                  Sim failed
                </span>
              )}
              <button onClick={onClose} className="text-muted hover:text-text transition-colors">
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {loading && (
              <div className="flex items-center gap-2 py-10 justify-center text-muted text-xs">
                <RefreshCw size={13} className="animate-spin" />
                Loading replay…
              </div>
            )}
            {!loading && error && (
              <div className="text-red-400 text-xs py-6 text-center">{error}</div>
            )}
            {!loading && !error && events.length === 0 && (
              <div className="text-muted text-xs py-6 text-center">
                No simulation events recorded yet.
                {!intentId && ' No intent ID — arm the project first.'}
              </div>
            )}
            {!loading && !error && events.map((e, i) => (
              <EventRow key={e.id ?? i} event={e} isLast={i === events.length - 1} />
            ))}
          </div>

          {/* Footer */}
          {!loading && simFailed && (
            <div className="px-4 py-3 border-t border-border shrink-0">
              <button
                onClick={handleRerun}
                disabled={rerunning}
                className={`w-full text-xs py-2 rounded border transition-colors ${
                  rerunning
                    ? 'opacity-50 cursor-not-allowed border-border text-muted'
                    : 'border-amber-500/40 text-amber-400 hover:border-amber-500/70 hover:bg-amber-500/5'
                }`}
              >
                {rerunning ? 'Requeueing…' : 'Rerun Simulation'}
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
