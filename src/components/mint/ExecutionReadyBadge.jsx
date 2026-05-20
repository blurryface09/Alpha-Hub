import React from 'react'
import { Zap, AlertCircle, Clock, CheckCircle, XCircle, Loader } from 'lucide-react'

// ── Inline badge ──────────────────────────────────────────────────────────────

/**
 * Small inline badge for the project card header row.
 * Shows nothing until we have a score.
 */
export function ExecutionReadyBadge({ readiness, loading }) {
  const { ready, score, status, staleCache, functionName } = readiness || {}

  if (loading && !score) {
    return (
      <span className="badge text-[10px] border-border2 text-muted flex items-center gap-0.5">
        <Loader size={8} className="animate-spin" />
        checking
      </span>
    )
  }

  if (!score && !ready) return null

  if (status === 'execution_ready') {
    const title = staleCache
      ? `Execution ready (cache refreshing) — ${functionName} detected`
      : `Execution ready — ${functionName} detected (${score}% confidence)`
    return (
      <span
        title={title}
        className="badge text-[10px] border-green/25 text-green bg-green/8 flex items-center gap-0.5"
      >
        <Zap size={9} className={staleCache ? 'opacity-60' : ''} />
        {score}% ready
      </span>
    )
  }

  if (status === 'partial') {
    return (
      <span
        title={`Partial readiness (${score}%) — prewarm running`}
        className="badge text-[10px] border-amber-500/25 text-amber-300 bg-amber-500/8 flex items-center gap-0.5"
      >
        <AlertCircle size={9} />
        {score}% ready
      </span>
    )
  }

  // not_ready and we have a score — show as warning
  if (score > 0) {
    return (
      <span
        title="Not yet execution ready"
        className="badge text-[10px] border-border2 text-muted2"
      >
        {score}% ready
      </span>
    )
  }

  return null
}

// ── Expanded readiness panel ──────────────────────────────────────────────────

const CHECK_ORDER = ['contract_valid', 'rpc_healthy', 'abi_known', 'function_cached', 'cache_fresh']

const CHECK_LABELS = {
  contract_valid:  'Contract',
  rpc_healthy:     'RPC',
  abi_known:       'ABI',
  function_cached: 'Mint function',
  cache_fresh:     'Cache',
}

function CheckRow({ id, check }) {
  if (!check) return null
  const label  = CHECK_LABELS[id] || check.label
  const Icon   = check.pass ? CheckCircle : XCircle
  const iconCls = check.pass ? 'text-green' : 'text-muted2'

  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-1.5">
        <Icon size={10} className={iconCls} />
        <span className={check.pass ? 'text-text' : 'text-muted'}>{label}</span>
      </div>
      <span className="text-muted font-mono text-[10px] truncate max-w-[160px]">{check.detail}</span>
    </div>
  )
}

function ScoreBar({ score }) {
  const color = score >= 75 ? 'bg-green' : score >= 40 ? 'bg-amber-400' : 'bg-red-500/60'
  return (
    <div className="w-full h-1 bg-surface2 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${score}%` }}
      />
    </div>
  )
}

/**
 * Full readiness breakdown panel, shown in the expanded card view.
 */
export function ReadinessPanel({ readiness, loading, onRefresh }) {
  const { ready, score, status, checks, blockers, warnings, staleCache, functionName, gasEstimate, avgLatencyMs, rpcCount } = readiness || {}

  const statusLabel = status === 'execution_ready'
    ? 'Execution Ready'
    : status === 'partial'
      ? 'Partial Readiness'
      : 'Not Ready'

  const statusColor = status === 'execution_ready'
    ? 'text-green'
    : status === 'partial'
      ? 'text-amber-300'
      : 'text-muted2'

  return (
    <div className="border-t border-border pt-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={12} className={ready ? 'text-green' : 'text-muted2'} />
          <span className="text-xs font-mono text-muted uppercase tracking-wider">Execution Readiness</span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader size={10} className="animate-spin text-muted" />}
          <span className={`text-xs font-semibold ${statusColor}`}>{statusLabel}</span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              className="text-muted hover:text-text transition-colors"
              title="Refresh readiness"
            >
              <Clock size={10} />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-muted">{score ?? 0}/100</span>
          <span className={`text-[10px] font-mono ${statusColor}`}>
            {staleCache ? 'cache refreshing…' : ''}
          </span>
        </div>
        <ScoreBar score={score ?? 0} />
      </div>

      <div className="space-y-1.5 bg-surface2 rounded-lg p-2.5">
        {CHECK_ORDER.map(id => (
          <CheckRow key={id} id={id} check={checks?.[id]} />
        ))}
      </div>

      {(blockers?.length > 0 || warnings?.length > 0) && (
        <div className="space-y-1">
          {blockers?.map((b, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-red-400">
              <XCircle size={10} className="mt-0.5 flex-shrink-0" />
              {b}
            </div>
          ))}
          {warnings?.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted">
              <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}

      {ready && functionName && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-green/5 border border-green/15 rounded-lg p-2">
            <div className="text-[10px] text-muted uppercase tracking-wider">Function</div>
            <div className="text-xs text-green font-mono mt-0.5 truncate">{functionName}</div>
          </div>
          {gasEstimate && (
            <div className="bg-surface2 rounded-lg p-2">
              <div className="text-[10px] text-muted uppercase tracking-wider">Gas</div>
              <div className="text-xs font-mono mt-0.5">{Number(gasEstimate).toLocaleString()}</div>
            </div>
          )}
          {avgLatencyMs != null && (
            <div className="bg-surface2 rounded-lg p-2">
              <div className="text-[10px] text-muted uppercase tracking-wider">Avg latency</div>
              <div className="text-xs font-mono mt-0.5">{avgLatencyMs}ms</div>
            </div>
          )}
        </div>
      )}

      {rpcCount?.total > 0 && (
        <div className="text-[10px] text-muted text-right">
          {rpcCount.healthy}/{rpcCount.total} RPCs healthy
        </div>
      )}
    </div>
  )
}
