import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Activity, RefreshCw, ChevronDown, ChevronUp,
  ExternalLink, Copy, AlertTriangle, CheckCircle2,
  Clock, Loader2, Zap, Search, XCircle, Radio, Database,
} from 'lucide-react'
import { getAuthToken } from '../lib/supabase'

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_META = {
  failed:    { label: 'Failed',    color: 'bg-red-500/10 text-red-400 border-red-500/20' },
  expired:   { label: 'Expired',   color: 'bg-red-500/10 text-red-400 border-red-500/20' },
  executing: { label: 'Executing', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  retrying:  { label: 'Retrying',  color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  pending:   { label: 'Pending',   color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  submitted: { label: 'Submitted', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  armed:     { label: 'Armed',     color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
  watching:  { label: 'Watching',  color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
  prepared:  { label: 'Prepared',  color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
  success:   { label: 'Success',   color: 'bg-green-500/10 text-green-400 border-green-500/20' },
  confirmed: { label: 'Confirmed', color: 'bg-green-500/10 text-green-400 border-green-500/20' },
}

const EVENT_STATE_COLOR = {
  failed:     'text-red-400',
  error:      'text-red-400',
  confirmed:  'text-green-400',
  success:    'text-green-400',
  simulating: 'text-amber-400',
  simulate:   'text-amber-400',
  pending:    'text-amber-400',
  submitted:  'text-amber-400',
  prewarm:    'text-cyan-400',
  preparing:  'text-cyan-400',
  optimized:  'text-violet-400',
  retry:      'text-orange-400',
}

const CHAIN_EXPLORER = {
  eth:      'https://etherscan.io/tx/',
  base:     'https://basescan.org/tx/',
  apechain: 'https://apescan.io/tx/',
  bnb:      'https://bscscan.com/tx/',
}

const FILTERS = [
  { key: 'all',      label: 'All' },
  { key: 'failed',   label: 'Failed' },
  { key: 'pending',  label: 'Pending' },
  { key: 'ready',    label: 'Ready' },
  { key: 'executed', label: 'Executed' },
  { key: 'waiting',  label: 'Waiting' },
]

const REFRESH_INTERVAL = 10_000

// ─── Utilities ────────────────────────────────────────────────────────────────

function relativeTime(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000)  return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function shortAddr(addr) {
  if (!addr) return '—'
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}

function shortHash(hash) {
  if (!hash) return null
  return hash.slice(0, 8) + '…' + hash.slice(-6)
}

function explorerUrl(chain, txHash) {
  if (!txHash) return null
  const base = CHAIN_EXPLORER[String(chain || '').toLowerCase()] || CHAIN_EXPLORER.eth
  return base + txHash
}

function copy(text) {
  navigator.clipboard.writeText(text).catch(() => {})
}

// ─── Countdown hook ───────────────────────────────────────────────────────────

function useCountdown(targetIso) {
  const [msLeft, setMsLeft] = useState(() => targetIso ? new Date(targetIso).getTime() - Date.now() : null)
  useEffect(() => {
    if (!targetIso) return
    const update = () => setMsLeft(new Date(targetIso).getTime() - Date.now())
    update()
    const id = setInterval(update, 250)
    return () => clearInterval(id)
  }, [targetIso])
  return msLeft
}

function fmtCountdown(ms) {
  if (ms == null) return null
  if (ms <= 0) return '00:00'
  const totalSec = Math.ceil(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: 'bg-slate-500/10 text-slate-400 border-slate-500/20' }
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${meta.color}`}>
      {meta.label}
    </span>
  )
}

function ChainBadge({ chain }) {
  const label = String(chain || 'eth').toUpperCase().slice(0, 4)
  return (
    <span className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface2 border border-border text-muted">
      {label}
    </span>
  )
}

function EventTimeline({ events, attempts }) {
  if (!events.length && !attempts.length) {
    return <p className="text-xs text-muted py-2">No execution events recorded.</p>
  }

  return (
    <div className="space-y-1.5 pt-1">
      {events.map((ev) => (
        <div key={ev.id} className="flex items-start gap-2.5">
          <div className="mt-1 w-1.5 h-1.5 rounded-full bg-current shrink-0 opacity-60"
            style={{ color: 'inherit' }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] font-mono font-semibold uppercase ${EVENT_STATE_COLOR[ev.state] || 'text-muted'}`}>
                {ev.state}
              </span>
              <span className="text-[10px] text-muted">{relativeTime(ev.created_at)}</span>
            </div>
            <p className="text-xs text-text/80 mt-0.5 leading-snug">{ev.message}</p>
            {ev.metadata && Object.keys(ev.metadata).length > 0 && (
              <MetadataChips metadata={ev.metadata} />
            )}
          </div>
        </div>
      ))}

      {attempts.map((att, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <div className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-400/60 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono font-semibold uppercase text-amber-400">
                attempt:{att.status}
              </span>
              {att.tx_hash && (
                <span className="text-[10px] font-mono text-muted">{shortHash(att.tx_hash)}</span>
              )}
              <span className="text-[10px] text-muted">{relativeTime(att.created_at)}</span>
            </div>
            {att.error_message && (
              <p className="text-xs text-red-400/80 mt-0.5 leading-snug break-all">{att.error_message}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function MetadataChips({ metadata }) {
  const SHOW_KEYS = ['fn', 'source', 'chain', 'rpc', 'to', 'value', 'gas', 'error_type', 'strategy']
  const entries = Object.entries(metadata)
    .filter(([k, v]) => SHOW_KEYS.includes(k) && v != null && v !== '')
    .slice(0, 6)
  if (!entries.length) return null

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {entries.map(([k, v]) => (
        <span key={k} className="inline-flex gap-1 items-center text-[10px] px-1.5 py-0.5 rounded bg-surface2/80 border border-border text-muted">
          <span className="opacity-60">{k}</span>
          <span className="text-text/70 font-mono truncate max-w-[80px]">{String(v)}</span>
        </span>
      ))}
    </div>
  )
}

// ─── Intent row ───────────────────────────────────────────────────────────────

function IntentRow({ intent, token }) {
  const [expanded, setExpanded] = useState(false)
  const [eventsState, setEventsState] = useState({ loading: false, events: [], attempts: [], loaded: false })

  const projectName = intent.wl_projects?.name || null
  const contractDisplay = shortAddr(intent.contract_address)
  const txUrl = explorerUrl(intent.chain, intent.tx_hash)
  const hasFailed = intent.status === 'failed' || intent.status === 'expired'
  const hasError  = Boolean(intent.strike_error)

  // Live countdown for armed intents with a future execute_at
  const isArmedWithTimer = ['armed', 'watching', 'prepared'].includes(intent.status) && intent.strike_execute_at
  const msLeft = useCountdown(isArmedWithTimer ? intent.strike_execute_at : null)
  const countdown = fmtCountdown(msLeft)
  const inPrewarm = msLeft != null && msLeft > 0 && msLeft < 30_000
  const isFiring  = msLeft != null && msLeft <= 0

  // Prewarm status from call_data field
  const hasCallData = Boolean(intent.call_data)

  const loadEvents = useCallback(async () => {
    if (eventsState.loaded) return
    setEventsState(s => ({ ...s, loading: true }))
    try {
      const res = await fetch(`/api/admin/intent-events?id=${intent.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setEventsState({ loading: false, loaded: true, events: data.events || [], attempts: data.attempts || [] })
    } catch {
      setEventsState(s => ({ ...s, loading: false, loaded: true }))
    }
  }, [intent.id, token, eventsState.loaded])

  const toggle = () => {
    if (!expanded) loadEvents()
    setExpanded(e => !e)
  }

  return (
    <div
      className={`border-b border-border last:border-0 transition-colors ${hasFailed ? 'hover:bg-red-500/[0.03]' : 'hover:bg-surface2/30'}`}
    >
      {/* Main row */}
      <button
        onClick={toggle}
        className="w-full text-left px-4 py-3 flex items-start gap-3"
      >
        {/* Status dot */}
        <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
          hasFailed                                                        ? 'bg-red-400' :
          ['executing','retrying','pending','submitted'].includes(intent.status) ? 'bg-amber-400 animate-pulse' :
          ['success','confirmed'].includes(intent.status)                 ? 'bg-green-400' :
          'bg-cyan-400'
        }`} />

        <div className="flex-1 min-w-0 space-y-1">
          {/* Row 1: project + chain + status */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text truncate max-w-[160px]">
              {projectName || contractDisplay}
            </span>
            {projectName && (
              <span className="text-[10px] font-mono text-muted hidden sm:inline">{contractDisplay}</span>
            )}
            <ChainBadge chain={intent.chain} />
            <StatusBadge status={intent.status} />
            {intent.function_name && (
              <span className="text-[10px] font-mono text-muted hidden md:inline">
                {intent.function_name}()
              </span>
            )}
          </div>

          {/* Row 2: last_state */}
          {intent.last_state && (
            <p className={`text-xs leading-snug truncate ${hasError ? 'text-red-400' : 'text-text/70'}`}>
              {intent.last_state}
            </p>
          )}

          {/* Row 3: strike_error (only when different from last_state) */}
          {hasError && intent.strike_error !== intent.last_state && (
            <p className="text-xs text-red-400/80 leading-snug break-words line-clamp-2 flex items-start gap-1.5">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              {intent.strike_error}
            </p>
          )}

          {/* Row 4: tx hash + time + countdown + prewarm badge */}
          <div className="flex items-center gap-3 flex-wrap">
            {intent.tx_hash ? (
              <a
                href={txUrl}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-1 text-[10px] font-mono text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                {shortHash(intent.tx_hash)}
                <ExternalLink size={10} />
              </a>
            ) : (
              <span className="text-[10px] text-muted font-mono">no tx</span>
            )}
            <span className="text-[10px] text-muted">{relativeTime(intent.updated_at)}</span>

            {/* Live countdown for armed intents */}
            {countdown && msLeft > 0 && (
              <span className={`text-[10px] font-mono flex items-center gap-1 ${
                inPrewarm ? 'text-amber-300 animate-pulse' : 'text-cyan-400'
              }`}>
                <Clock size={9} />
                {countdown}
                {inPrewarm && <span className="text-[9px] text-amber-300/70">prewarming</span>}
              </span>
            )}
            {isFiring && (
              <span className="text-[10px] font-mono text-green-400 flex items-center gap-1 animate-pulse">
                <Zap size={9} /> FIRING
              </span>
            )}

            {/* Prewarm / call_data ready badge */}
            {hasCallData && isArmedWithTimer && (
              <span
                title="Call data precomputed — executor will skip function detection at T=0"
                className="text-[10px] font-mono text-green-400/80 flex items-center gap-1"
              >
                <Database size={9} /> prewarmed
              </span>
            )}
          </div>
        </div>

        {/* Expand toggle */}
        <div className="shrink-0 mt-1 text-muted">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {/* Expanded: execution trace */}
      {expanded && (
        <div className="px-9 pb-4">
          <div className="border-l-2 border-border pl-4">
            <div className="section-label mb-2">Execution trace</div>
            {/* intent fields */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mb-3">
              {[
                ['id',       intent.id?.slice(0, 8) + '…'],
                ['chain',    intent.chain],
                ['contract', shortAddr(intent.contract_address)],
                ['to',       intent.to ? shortAddr(intent.to) : null],
                ['fn',       intent.function_name],
                ['sim',      intent.simulation_status],
              ].filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted font-mono">{k}</span>
                  <span className="text-[10px] font-mono text-text/80">{v}</span>
                </div>
              ))}
            </div>

            {eventsState.loading ? (
              <div className="flex items-center gap-2 text-xs text-muted py-2">
                <Loader2 size={12} className="animate-spin" />
                Loading events…
              </div>
            ) : (
              <EventTimeline events={eventsState.events} attempts={eventsState.attempts} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ExecutionMonitorPage() {
  const [filter,     setFilter]     = useState('all')
  const [search,     setSearch]     = useState('')
  const [intents,    setIntents]    = useState([])
  const [counts,     setCounts]     = useState({})
  const [loading,    setLoading]    = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [token,      setToken]      = useState(null)
  const [error,      setError]      = useState(null)
  const timerRef = useRef(null)

  const fetchIntents = useCallback(async (tok, f, s) => {
    const t = tok || token
    if (!t) return
    try {
      const params = new URLSearchParams({ filter: f || filter })
      if (s || search) params.set('search', (s ?? search).trim())
      const res = await fetch(`/api/admin/intents?${params}`, {
        headers: { Authorization: `Bearer ${t}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      const data = await res.json()
      setIntents(data.intents || [])
      setCounts(data.counts || {})
      setLastUpdate(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [token, filter, search])

  // Initial load + get auth token
  useEffect(() => {
    let cancelled = false
    getAuthToken().then(tok => {
      if (cancelled) return
      setToken(tok)
      fetchIntents(tok, filter, search)
    })
    return () => { cancelled = true }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh
  useEffect(() => {
    clearInterval(timerRef.current)
    timerRef.current = setInterval(() => fetchIntents(), REFRESH_INTERVAL)
    return () => clearInterval(timerRef.current)
  }, [fetchIntents])

  // Refetch when filter changes
  useEffect(() => {
    if (!token) return
    setLoading(true)
    fetchIntents(token, filter, search)
  }, [filter])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = (e) => {
    const val = e.target.value
    setSearch(val)
    if (val.length === 0 || val.length >= 4) {
      if (token) fetchIntents(token, filter, val)
    }
  }

  const manualRefresh = () => {
    setLoading(true)
    fetchIntents()
  }

  const secAgo = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-text flex items-center gap-2">
            <Activity size={20} className="text-accent" />
            Execution Monitor
          </h1>
          <p className="text-xs text-muted mt-0.5">
            Real-time intent pipeline visibility — read only
          </p>
        </div>

        <div className="flex items-center gap-2">
          {lastUpdate && (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Radio size={11} className="text-green-400 animate-pulse" />
              {secAgo !== null ? `${secAgo}s ago` : 'live'}
            </div>
          )}
          <button
            onClick={manualRefresh}
            disabled={loading}
            className="p-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition-all disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          className="input w-full pl-9 text-sm"
          placeholder="Search by contract or tx hash…"
          value={search}
          onChange={handleSearch}
        />
        {search && (
          <button
            onClick={() => { setSearch(''); fetchIntents(token, filter, '') }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
          >
            <XCircle size={14} />
          </button>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map(f => {
          const count = counts[f.key]
          const active = filter === f.key
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                active
                  ? 'bg-accent/10 text-accent border-accent/30'
                  : 'border-border text-muted hover:text-text hover:border-border2 bg-surface2/50'
              }`}
            >
              {f.label}
              {count != null && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                  active ? 'bg-accent/20 text-accent' : 'bg-surface2 text-muted'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Intent list */}
      <div className="card p-0 overflow-hidden">
        {/* Column headers — desktop */}
        <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2 border-b border-border bg-surface2/40">
          <span className="section-label mb-0">Project / Contract</span>
          <span className="section-label mb-0">Status</span>
          <span className="section-label mb-0">Tx</span>
          <span className="section-label mb-0">Updated</span>
        </div>

        {loading && intents.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={22} className="animate-spin text-muted" />
          </div>
        ) : intents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            {filter === 'failed' ? (
              <CheckCircle2 size={28} className="text-green-400/60" />
            ) : (
              <Zap size={28} className="text-muted/40" />
            )}
            <p className="text-sm text-muted">
              {filter === 'all' ? 'No intents found' : `No ${filter} intents`}
            </p>
          </div>
        ) : (
          <div>
            {intents.map(intent => (
              <IntentRow key={intent.id} intent={intent} token={token} />
            ))}
            <div className="px-4 py-2 text-[10px] text-muted text-right">
              {intents.length} intent{intents.length !== 1 ? 's' : ''} shown · refreshes every 10s
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
