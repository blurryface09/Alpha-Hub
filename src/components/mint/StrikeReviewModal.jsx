import React, { useState, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Zap, X, Shield, AlertTriangle, CheckCircle, XCircle,
  Clock, Cpu, Wifi, RefreshCw, ChevronRight,
} from 'lucide-react'
import { getAuthToken } from '../../lib/supabase'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    })
  } catch { return iso }
}

function fmtGwei(wei) {
  if (!wei) return null
  const n = Number(wei)
  if (n === 0) return 'Free'
  if (n < 1e9) return `${n} wei`
  return `${(n / 1e18).toFixed(4)} ETH`
}

function fmtGas(gas) {
  if (!gas) return null
  const n = Number(gas)
  if (!n) return null
  return n.toLocaleString()
}

function chainLabel(chain) {
  return { eth: 'Ethereum', base: 'Base', apechain: 'ApeChain', bnb: 'BNB Chain' }[chain] ?? chain
}

function addrShort(addr) {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─── Checklist item ───────────────────────────────────────────────────────────

function CheckItem({ ok, warn, label, detail }) {
  const icon = ok
    ? <CheckCircle size={13} className="text-green shrink-0 mt-0.5" />
    : warn
      ? <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
      : <XCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
  return (
    <div className="flex items-start gap-2 py-1">
      {icon}
      <div className="flex-1 min-w-0">
        <span className={`text-xs ${ok ? 'text-text' : warn ? 'text-amber-300' : 'text-red-300'}`}>{label}</span>
        {detail && <div className="text-[10px] text-muted mt-0.5">{detail}</div>}
      </div>
    </div>
  )
}

// ─── Review row ───────────────────────────────────────────────────────────────

function Row({ label, value, mono = true, dim }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted shrink-0 w-28">{label}</span>
      <span className={`text-xs text-right truncate flex-1 ${mono ? 'font-mono' : ''} ${dim ? 'text-muted italic' : 'text-text'}`}>
        {value || '—'}
      </span>
    </div>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div>
      <p className="text-[10px] font-mono uppercase tracking-wider text-muted/60 mb-1.5">{title}</p>
      {children}
    </div>
  )
}

// ─── UI state badge ───────────────────────────────────────────────────────────

export function strikeUiState(project, simResult) {
  if (!project) return 'idle'
  const hasContract = Boolean(project.contract_address)
  const hasChain = Boolean(project.chain)
  if (!hasContract || !hasChain) return 'blocked'
  if (project.mint_status === 'needs_review' || project.status === 'needs_review') return 'needs_review'
  if (!simResult) return 'ready'
  if (simResult.blockers?.length) return 'blocked'
  if (!simResult.live_execution_enabled) return 'simulation_only'
  return 'ready'
}

const UI_STATE_LABELS = {
  idle:            { label: 'Strike',          cls: 'border-border2 text-muted' },
  ready:           { label: 'Ready',           cls: 'border-green/40 text-green' },
  simulation_only: { label: 'Sim only',        cls: 'border-purple-500/40 text-purple-300' },
  blocked:         { label: 'Blocked',         cls: 'border-red-500/30 text-red-400' },
  needs_review:    { label: 'Needs review',    cls: 'border-amber-500/30 text-amber-400' },
  armed:           { label: 'Armed',           cls: 'border-green/40 text-green' },
  sim_armed:       { label: 'Sim armed',       cls: 'border-purple-500/40 text-purple-300' },
  executing:       { label: 'Executing…',      cls: 'border-cyan-500/40 text-cyan-300' },
  sim_executing:   { label: 'Sim running…',    cls: 'border-purple-500/40 text-purple-300' },
  sim_passed:      { label: 'Sim passed',      cls: 'border-green/40 text-green' },
  sim_failed:      { label: 'Sim failed',      cls: 'border-red-500/30 text-red-400' },
}

export function UiStateBadge({ state }) {
  const { label, cls } = UI_STATE_LABELS[state] || UI_STATE_LABELS.idle
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function StrikeReviewModal({ project, vault, onConfirmArm, onClose }) {
  const [simLoading, setSimLoading] = useState(false)
  const [simResult, setSimResult] = useState(null)
  const [arming, setArming] = useState(false)
  const [armError, setArmError] = useState(null)

  // ── Derived checklist ───────────────────────────────────────────────────────
  const checklist = useMemo(() => {
    const items = []
    items.push({
      id: 'vault',
      ok: Boolean(vault),
      warn: false,
      label: 'Alpha Vault',
      detail: vault ? addrShort(vault.address || vault.wallet_address) : 'No vault — create one in Settings',
    })
    items.push({
      id: 'contract',
      ok: Boolean(project.contract_address),
      warn: false,
      label: 'Contract address',
      detail: project.contract_address ? addrShort(project.contract_address) : 'Not set',
    })
    items.push({
      id: 'chain',
      ok: Boolean(project.chain),
      warn: false,
      label: 'Chain',
      detail: project.chain ? chainLabel(project.chain) : 'Not configured',
    })

    const hasTime = Boolean(project.mint_date)
    const isLive = project.status === 'live' || project.mint_status === 'live_now'
    items.push({
      id: 'timing',
      ok: hasTime || isLive,
      warn: !hasTime && !isLive,
      label: 'Mint time',
      detail: hasTime ? fmtDate(project.mint_date) : isLive ? 'Live now — execute immediately' : 'Unknown — Strike fires on live detection',
    })

    const priceKnown = project.mint_price !== null && project.mint_price !== undefined
    items.push({
      id: 'price',
      ok: priceKnown,
      warn: !priceKnown,
      label: 'Mint price',
      detail: priceKnown ? fmtGwei(project.mint_price) || project.mint_price : 'Unconfirmed — max spend cap will apply',
    })

    const notNeedsReview = project.status !== 'needs_review' && project.mint_status !== 'needs_review'
    items.push({
      id: 'status',
      ok: notNeedsReview,
      warn: !notNeedsReview,
      label: 'Project status',
      detail: notNeedsReview ? (project.status || 'ok') : 'Needs review — verify details before arming',
    })

    const liveEnabled = simResult?.live_execution_enabled === true
    items.push({
      id: 'live_exec',
      ok: liveEnabled,
      warn: !liveEnabled,
      label: 'Live execution',
      detail: liveEnabled
        ? 'LIVE_EXECUTION_ENABLED=true — live minting active'
        : simResult
          ? 'LIVE_EXECUTION_ENABLED=false — run simulation to check, or contact admin'
          : 'Run simulation to check live execution status',
    })

    return items
  }, [project, vault])

  const hardBlockers = checklist.filter(c => !c.ok && !c.warn)
  const canArm = hardBlockers.length === 0

  // ── Simulation ──────────────────────────────────────────────────────────────
  async function runSimulation() {
    setSimLoading(true)
    setSimResult(null)
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/mint/strike-simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          contractAddress: project.contract_address,
          chain: project.chain,
          mintPrice: project.mint_price,
          mintDate: project.mint_date,
          projectStatus: project.status,
          quantity: project.max_mint || 1,
          maxTotalSpend: project.max_total_spend || '0.05',
        }),
      })
      const data = await res.json().catch(() => ({}))
      setSimResult(data?.simulation ?? null)
    } catch (err) {
      setSimResult({ blockers: [err.message], warnings: [], wallet_ready: false, contract_valid: false })
    } finally {
      setSimLoading(false)
    }
  }

  // ── Arm ─────────────────────────────────────────────────────────────────────
  async function handleArm(simulationOnly) {
    if (!canArm || arming) return
    setArming(simulationOnly ? 'sim' : 'live')
    setArmError(null)
    try {
      await onConfirmArm(project, { simulationOnly })
      onClose()
    } catch (err) {
      setArmError(err.message)
    } finally {
      setArming(false)
    }
  }

  const liveExecEnabled = simResult?.live_execution_enabled === true
  const canArmLive = canArm && liveExecEnabled && !simResult?.blockers?.length

  // ── Phase timeline (if simResult has events) ────────────────────────────────
  const timeline = simResult?.timeline ?? null

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
          className="relative z-10 bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2.5">
              <Zap size={16} className="text-amber-400" />
              <div>
                <h2 className="text-sm font-semibold text-text">Strike Review</h2>
                <p className="text-xs text-muted truncate max-w-[260px]">{project.name}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

            {/* Intent summary */}
            <Section title="Configuration">
              <div className="bg-bg/50 rounded-lg px-3 py-1">
                <Row label="Project"      value={project.name}                               mono={false} />
                <Row label="Chain"        value={chainLabel(project.chain)}                  />
                <Row label="Contract"     value={addrShort(project.contract_address)}        dim={!project.contract_address} />
                <Row label="Mint time"    value={fmtDate(project.mint_date)}                 dim={!project.mint_date} />
                <Row label="Mint stage"   value={project.mint_status || project.status}      />
                <Row label="Quantity"     value={project.max_mint || '1'}                    />
                <Row label="Max spend"    value={project.max_total_spend ? `${project.max_total_spend} ETH` : null} dim={!project.max_total_spend} />
                <Row label="Vault"        value={addrShort(vault?.address || vault?.wallet_address)} dim={!vault} />
                <Row label="Gas strategy" value="Balanced (EIP-1559)"                       />
                <Row label="RPC mode"     value={chainLabel(project.chain) + ' — auto failover'} />
                <Row label="Retry policy" value="3× with exponential backoff"               />
                <Row label="Execution"    value={simResult?.live_execution_enabled ? 'LIVE_EXECUTION_ENABLED=true ✓' : 'LIVE_EXECUTION_ENABLED=false'} />
              </div>
            </Section>

            {/* Readiness checklist */}
            <Section title="Readiness checklist">
              <div className="bg-bg/50 rounded-lg px-3 py-1">
                {checklist.map(item => (
                  <CheckItem key={item.id} ok={item.ok} warn={item.warn} label={item.label} detail={item.detail} />
                ))}
              </div>
              {hardBlockers.length > 0 && (
                <div className="mt-2 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2 space-y-1">
                  <p className="text-[10px] font-mono text-red-400 uppercase tracking-wider">Arming blocked</p>
                  {hardBlockers.map(b => (
                    <p key={b.id} className="text-xs text-red-300 flex items-start gap-1.5">
                      <XCircle size={10} className="mt-0.5 shrink-0" /> {b.detail || b.label}
                    </p>
                  ))}
                </div>
              )}
            </Section>

            {/* Simulation result */}
            {simResult && (
              <Section title="Simulation result">
                <div className="bg-bg/50 rounded-lg px-3 py-1">
                  <CheckItem
                    ok={simResult.wallet_ready}
                    warn={false}
                    label="Wallet ready"
                    detail={simResult.wallet_address ? addrShort(simResult.wallet_address) : 'Not loaded'}
                  />
                  <CheckItem
                    ok={simResult.contract_valid}
                    warn={false}
                    label="Contract valid"
                    detail={simResult.function_name ? `Function: ${simResult.function_name}` : 'Validation failed'}
                  />
                  <CheckItem
                    ok={simResult.rpc_available}
                    warn={!simResult.rpc_available}
                    label="RPC available"
                    detail={simResult.rpc_url || 'No RPC configured'}
                  />
                  {simResult.estimated_gas && (
                    <Row label="Est. gas" value={`${fmtGas(simResult.estimated_gas)} units`} />
                  )}
                  <Row label="Gas strategy" value={simResult.gas_strategy || 'balanced'} />
                  <Row label="Execute at" value={fmtDate(simResult.execution_timing) || simResult.execution_timing} dim={!simResult.execution_timing} />
                </div>
                {simResult.blockers?.length > 0 && (
                  <div className="mt-2 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2 space-y-1">
                    <p className="text-[10px] font-mono text-red-400 uppercase tracking-wider">Simulation blockers</p>
                    {simResult.blockers.map((b, i) => (
                      <p key={i} className="text-xs text-red-300 flex items-start gap-1.5">
                        <XCircle size={10} className="mt-0.5 shrink-0" /> {b}
                      </p>
                    ))}
                  </div>
                )}
                {simResult.warnings?.length > 0 && (
                  <div className="mt-2 bg-amber-400/8 border border-amber-400/20 rounded-lg px-3 py-2 space-y-1">
                    <p className="text-[10px] font-mono text-amber-300 uppercase tracking-wider">Warnings</p>
                    {simResult.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-200/80 flex items-start gap-1.5">
                        <AlertTriangle size={10} className="mt-0.5 shrink-0" /> {w}
                      </p>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {/* Execution phase replay */}
            {timeline?.length > 0 && (
              <Section title="Execution timeline">
                <div className="bg-bg/50 rounded-lg px-3 py-1 space-y-1 font-mono">
                  {timeline.map((e, i) => (
                    <div key={i} className="flex items-start gap-2 py-0.5">
                      <span className="text-[10px] text-muted w-14 shrink-0">{e.elapsed_ms ?? '—'}ms</span>
                      <span className="text-[10px] text-muted w-20 shrink-0">{e.phase}</span>
                      <span className="text-[10px] text-text/70 truncate">{e.message}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Risk note */}
            <div className="bg-amber-400/6 border border-amber-400/15 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-mono text-amber-400/80 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Shield size={9} /> Risk acknowledgment
              </p>
              <p className="text-xs text-amber-200/70 leading-relaxed">
                Strike Mode will execute transactions through Alpha Vault when the mint goes live.
                Use a dedicated burner wallet. Set a max spend limit. Do not deposit more than you can afford to lose.
                This arm is simulation-only — no real transactions will be sent until LIVE_EXECUTION_ENABLED is enabled.
              </p>
            </div>

            {armError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <p className="text-xs text-red-300">{armError}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
            <button
              onClick={runSimulation}
              disabled={simLoading || !project.contract_address}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-border2 text-muted hover:border-accent hover:text-accent transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {simLoading
                ? <><div className="spinner w-3 h-3" /> Simulating…</>
                : <><Cpu size={12} /> Run Simulation</>
              }
            </button>

            <div className="flex items-center gap-2">
              <button onClick={onClose} className="text-xs px-3 py-2 rounded-md border border-border2 text-muted hover:text-text transition-all">
                Cancel
              </button>

              {/* Simulation-only arm */}
              <button
                onClick={() => handleArm(true)}
                disabled={!canArm || arming}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-purple-500/40 text-purple-300 bg-purple-500/8 hover:bg-purple-500/15 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {arming === 'sim'
                  ? <><div className="spinner w-3 h-3" /> Arming…</>
                  : <><Cpu size={12} /> Arm Sim</>
                }
              </button>

              {/* Live arm — enabled when LIVE_EXECUTION_ENABLED=true confirmed by simulation */}
              <button
                onClick={() => handleArm(false)}
                disabled={!canArmLive || arming}
                title={!liveExecEnabled ? 'Run simulation first — LIVE_EXECUTION_ENABLED must be true' : !canArm ? 'Fix blockers before arming live' : 'Arm Strike for live execution'}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-amber-500/40 text-amber-300 bg-amber-500/8 hover:bg-amber-500/15 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {arming === 'live'
                  ? <><div className="spinner w-3 h-3" /> Arming…</>
                  : <><Zap size={12} /> Arm Live</>
                }
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
