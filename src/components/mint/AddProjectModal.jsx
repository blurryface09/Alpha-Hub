import React, { useState, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Shield, Loader, Sparkles, AlertTriangle, CheckCircle,
  Info, ChevronRight, ChevronDown, ChevronUp, ExternalLink, Zap
} from 'lucide-react'
import toast from 'react-hot-toast'
import DateTimePicker from '../shared/DateTimePicker'

// ── Confidence badge ──────────────────────────────────────────────────────────
function ConfBadge({ level }) {
  if (level === 'api_verified' || level === 'url_extracted') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-green px-1.5 py-0.5 bg-green/10 rounded">
      <CheckCircle size={9} /> {level === 'api_verified' ? 'Verified' : 'Extracted'}
    </span>
  )
  if (level === 'ai_inferred') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-yellow-400 px-1.5 py-0.5 bg-yellow-400/10 rounded">
      <Sparkles size={9} /> AI guess
    </span>
  )
  if (level === 'page_detected') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-blue-400 px-1.5 py-0.5 bg-blue-400/10 rounded">
      <Info size={9} /> Page
    </span>
  )
  return null
}

// ── Missing field chips (calm, contextual — no harsh red) ──────────────────────
function MissingChip({ type }) {
  const chips = {
    mint_date:        { color: 'text-amber-300  bg-amber-400/10  border-amber-400/20',  icon: '⏱', label: 'Needs time'     },
    mint_price:       { color: 'text-muted      bg-muted/10      border-border2',        icon: '$',  label: 'Optional price' },
    contract_address: { color: 'text-orange-300 bg-orange-400/10 border-orange-400/20', icon: '📄', label: 'Needs contract' },
    chain:            { color: 'text-orange-300 bg-orange-400/10 border-orange-400/20', icon: '⛓', label: 'Needs chain'    },
  }
  const c = chips[type]
  if (!c) return null
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${c.color}`}>
      {c.icon} {c.label}
    </span>
  )
}

// ── "Minting Now" live status badge ───────────────────────────────────────────
function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2.5 py-1 rounded-full bg-green/15 text-green border border-green/30 animate-pulse-slow font-semibold">
      <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse inline-block" />
      Minting Now
    </span>
  )
}

// ── Phase label map ───────────────────────────────────────────────────────────
const PHASE_LABELS = {
  gtd:          'GTD Allowlist',
  wl:           'Whitelist',
  wl_fcfs:      'WL (FCFS)',
  public:       'Public',
  public_fcfs:  'Public (FCFS)',
  open_edition: 'Open Edition',
  claim:        'Claim',
  unknown:      'Unknown',
}

// ── Constants ─────────────────────────────────────────────────────────────────
const WL_TYPES = [
  { val: 'GTD',     label: 'GTD / Allowlist',               desc: 'Guaranteed spot' },
  { val: 'FCFS',    label: 'FCFS',                          desc: 'First come first served' },
  { val: 'PUBLIC',  label: 'Public (Open Edition · Claim)', desc: 'Open to everyone' },
  { val: 'RAFFLE',  label: 'Raffle',                        desc: 'Random selection' },
  { val: 'UNKNOWN', label: 'TBA / Unknown',                 desc: 'Not confirmed yet' },
]

const MINT_MODES = [
  { val: 'confirm', label: 'Confirm', icon: '✓', desc: 'App asks before minting' },
  { val: 'auto',    label: 'Auto',    icon: '⚡', desc: 'Fires the moment mint goes live' },
]

const CHAINS = [
  { val: 'eth',  label: 'Ethereum' },
  { val: 'base', label: 'Base' },
  { val: 'bnb',  label: 'BNB Chain' },
]

// ── Strike Mode blockers ──────────────────────────────────────────────────────
function getStrikeBlockers(form) {
  const b = []
  if (!form.contract_address?.trim()) b.push('Contract address required for Strike Mode')
  if (!form.mint_date)                b.push('Mint date/time required for Strike Mode')
  if (!form.mint_price && form.mint_price !== '0') b.push('Mint price unconfirmed — Strike Mode may overbid')
  return b
}

// ── Review row ────────────────────────────────────────────────────────────────
function ReviewRow({ label, value, conf, placeholder = '—' }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted w-24 shrink-0">{label}</span>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={`text-xs font-mono truncate ${!value ? 'text-muted italic' : 'text-text'}`}>
          {value || placeholder}
        </span>
        {conf && <ConfBadge level={conf} />}
      </div>
    </div>
  )
}

// ── Skeleton row for loading state ────────────────────────────────────────────
function SkeletonRow() {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0">
      <div className="w-20 h-3 bg-border/50 rounded animate-pulse" />
      <div className="w-28 h-3 bg-border/30 rounded animate-pulse" />
    </div>
  )
}

// ── Default form state ────────────────────────────────────────────────────────
const EMPTY_FORM = {
  name: '', source_url: '', source_type: 'website', chain: 'eth',
  contract_address: '', mint_date: '', mint_price: '', mint_phase: '',
  wl_type: 'UNKNOWN', mint_mode: 'confirm', max_mint: 1, gas_limit: 200000, notes: '',
}

function makeForm(overrides = {}) {
  return { ...EMPTY_FORM, ...overrides }
}

// ── Modal (exported) ──────────────────────────────────────────────────────────
export default function AddProjectModal({ onAdd, onClose }) {
  const [step,     setStep]     = useState(1)
  const [url,      setUrl]      = useState('')
  const [loading,  setLoading]  = useState(false)
  const [meta,     setMeta]     = useState(null)
  const [form,     setForm]     = useState(() => makeForm())
  const [saving,   setSaving]   = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const urlRef = useRef(null)

  const set = useCallback((key, val) => setForm(f => ({ ...f, [key]: val })), [])
  const toggleAdvanced = useCallback(() => setAdvanced(a => !a), [])

  // ── Step 1: analyse ──────────────────────────────────────────────────────
  const handleAnalyse = useCallback(async () => {
    const trimmed = url.trim()
    if (!trimmed) { toast.error('Paste a URL, contract address, or alpha text first'); return }
    setLoading(true)
    try {
      const resp = await fetch(`/api/metadata?url=${encodeURIComponent(trimmed)}`)
      const data = await resp.json()
      setMeta(data)
      setForm(makeForm({
        source_url:       trimmed,
        name:             data.name             || '',
        source_type:      data.source_type      || 'website',
        chain:            data.chain            || 'eth',
        contract_address: data.contract_address || '',
        mint_price:       data.mint_price       || '',
        mint_date:        data.mint_date        || '',
        mint_phase:       data.mint_phase       || '',
        wl_type:          data.wl_type          || 'UNKNOWN',
        notes:            data.notes            || '',
      }))
      setStep(2)
    } catch {
      // URL-only fallback (no API response)
      const mT = trimmed.match(/(?:twitter|x)\.com\/([^/?#]+)/)
      const mO = trimmed.match(/opensea\.io\/collection\/([^/?#]+)/)
      const name = mT ? mT[1]
        : mO ? mO[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : ''
      setForm(makeForm({ source_url: trimmed, name }))
      setMeta(null)
      setStep(2)
    } finally {
      setLoading(false)
    }
  }, [url])

  // ── Step 2: save ─────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (asNeedsReview = false) => {
    if (!form.name.trim()) { toast.error('Project name is required'); return }
    const notesValue = asNeedsReview
      ? [form.notes?.trim(), 'Needs review — mint time not confirmed'].filter(Boolean).join(' | ')
      : form.notes?.trim() || null
    const cleanForm = {
      ...form,
      gas_limit:        parseInt(form.gas_limit)      || 200000,
      max_mint:         parseInt(form.max_mint)       || 1,
      contract_address: form.contract_address?.trim() || null,
      mint_date:        form.mint_date                || null,
      mint_price:       form.mint_price?.trim()       || null,
      mint_phase:       form.mint_phase               || null,
      notes:            notesValue,
    }
    setSaving(true)
    try {
      await onAdd(cleanForm)
    } catch (err) {
      toast.error('Save failed: ' + err.message)
    } finally {
      setSaving(false)
    }
  }, [form, onAdd])

  // ── Derived state (memoised) ──────────────────────────────────────────────
  const conf        = meta?.confidence || {}
  const isLiveNow   = meta?.mint_status === 'live_now'
  const isEnded     = meta?.mint_status === 'ended'

  const missingChips = useMemo(() => {
    const chips = []
    if (!isLiveNow && !form.mint_date)        chips.push('mint_date')
    if (!form.contract_address)               chips.push('contract_address')
    if (!form.mint_price)                     chips.push('mint_price')
    return chips
  }, [isLiveNow, form.mint_date, form.contract_address, form.mint_price])

  const strikeBlockers = useMemo(() =>
    form.mint_mode === 'auto' ? getStrikeBlockers(form) : [],
  [form])

  const onKeyDownUrl = useCallback(e => { if (e.key === 'Enter') handleAnalyse() }, [handleAnalyse])
  const onChangeUrl  = useCallback(e => setUrl(e.target.value), [])
  const onSkip       = useCallback(() => { setMeta(null); setForm(makeForm()); setStep(2) }, [])
  const onBack       = useCallback(() => setStep(1), [])

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1,    y: 0   }}
        exit={{    opacity: 0, scale: 0.96, y: 6   }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent" />
            <h2 className="font-bold text-sm">
              {step === 1 ? 'Add Alpha' : form.name || 'New Project'}
            </h2>
            {step === 2 && isLiveNow && <LiveBadge />}
          </div>
          <div className="flex items-center gap-2">
            {step === 2 && (meta?.source_url || url) && (
              <a href={meta?.source_url || url} target="_blank" rel="noreferrer"
                 className="text-muted hover:text-accent p-1" title="View source">
                <ExternalLink size={14} />
              </a>
            )}
            <button onClick={onClose} className="text-muted hover:text-text p-1">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-5">
          <AnimatePresence mode="wait">

            {/* ── STEP 1: Paste ── */}
            {step === 1 && (
              <motion.div key="step1"
                initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}
                className="space-y-4"
              >
                <p className="text-xs text-muted">
                  Paste a URL, contract address <span className="font-mono">0x…</span>,
                  or raw alpha text. We'll extract details automatically.
                </p>
                <div className="flex gap-2">
                  <input
                    ref={urlRef}
                    className="input flex-1"
                    placeholder="opensea.io/collection/… · 0x… · plain alpha"
                    value={url}
                    onChange={onChangeUrl}
                    onKeyDown={onKeyDownUrl}
                    autoFocus
                  />
                  <button onClick={handleAnalyse} disabled={loading}
                    className="btn-primary px-4 flex items-center gap-2 shrink-0">
                    {loading
                      ? <Loader size={14} className="animate-spin" />
                      : <><Sparkles size={14} /><span>Analyse</span></>}
                  </button>
                </div>
                <p className="text-[10px] text-muted opacity-60">
                  Supports: OpenSea · Zora · Magic Eden · Twitter/X · Contract 0x… · Any site · Plain text
                </p>
                <div className="flex justify-end">
                  <button onClick={onSkip} className="text-xs text-accent hover:underline flex items-center gap-1">
                    Skip — fill manually <ChevronRight size={12} />
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── STEP 2: Review + Fill ── */}
            {step === 2 && (
              <motion.div key="step2"
                initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
                className="space-y-5"
              >
                {/* Intelligence Report card */}
                {meta && (
                  <div className="bg-bg border border-border/60 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-mono text-muted uppercase tracking-wider flex items-center gap-1.5">
                        <Sparkles size={9} className="text-accent" /> Intelligence Report
                      </p>
                      {isLiveNow && <LiveBadge />}
                      {isEnded  && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-muted/10 text-muted border border-border2">
                          Ended
                        </span>
                      )}
                    </div>

                    <ReviewRow label="Name"
                      value={meta.name}
                      conf={conf.name}
                      placeholder="Not detected" />
                    <ReviewRow label="Chain"
                      value={meta.chain?.toUpperCase()}
                      conf={conf.chain}
                      placeholder="Not detected" />
                    <ReviewRow label="Contract"
                      value={meta.contract_address
                        ? `${meta.contract_address.slice(0,6)}…${meta.contract_address.slice(-4)}`
                        : null}
                      conf={conf.contract_address}
                      placeholder="Not detected" />
                    <ReviewRow
                      label={isLiveNow ? 'Mint State' : 'Mint Date'}
                      value={isLiveNow
                        ? 'Minting Now'
                        : meta.mint_date
                          ? new Date(meta.mint_date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                          : null}
                      conf={isLiveNow ? 'api_verified' : conf.mint_date}
                      placeholder="Not detected" />
                    <ReviewRow label="Price"
                      value={meta.mint_price
                        ? `${meta.mint_price} ${meta.chain === 'bnb' ? 'BNB' : 'ETH'}`
                        : null}
                      conf={conf.mint_price}
                      placeholder="Not detected" />
                    {meta.mint_phase && meta.mint_phase !== 'unknown' && (
                      <ReviewRow label="Phase"
                        value={PHASE_LABELS[meta.mint_phase] || meta.mint_phase}
                        conf={conf.mint_phase} />
                    )}

                    {/* Multi-stage breakdown — only real stage names */}
                    {Array.isArray(meta.stages) && meta.stages.length >= 2 && (
                      <div className="mt-2 pt-2 border-t border-border/40">
                        <p className="text-[10px] text-muted uppercase tracking-wider mb-1.5 font-mono">Stages</p>
                        {meta.stages.slice(0, 4).map((s, i) => (
                          <div key={i} className="flex items-center justify-between text-[10px] font-mono py-0.5">
                            <span className="text-muted truncate max-w-[110px]">
                              {s.name || `Stage ${i + 1}`}
                            </span>
                            <span className="text-text">
                              {s.price != null ? `${s.price} ETH` : ''}
                              {s.start_time
                                ? ` · ${new Date(s.start_time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                                : ''}
                            </span>
                          </div>
                        ))}
                        {meta.stages.length > 4 && (
                          <p className="text-[10px] text-muted mt-0.5">+{meta.stages.length - 4} more</p>
                        )}
                      </div>
                    )}

                    {meta.warning && (
                      <div className="mt-2 flex items-start gap-1.5 text-yellow-400 bg-yellow-400/8 rounded-lg p-2">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <span className="text-xs">{meta.warning}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Loading skeleton (while fetching) */}
                {loading && (
                  <div className="bg-bg border border-border/60 rounded-xl p-3 space-y-0">
                    {[...Array(5)].map((_, i) => <SkeletonRow key={i} />)}
                  </div>
                )}

                {/* Missing field chips */}
                {missingChips.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {missingChips.map(f => <MissingChip key={f} type={f} />)}
                  </div>
                )}

                {/* Project Name */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider">Project Name *</label>
                    {conf.name && <ConfBadge level={conf.name} />}
                  </div>
                  <input className="input" placeholder="e.g. CryptoSkulls"
                    value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
                </div>

                {/* Mint Date — hidden when live now (no timestamp needed) */}
                {!isLiveNow && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-mono text-muted uppercase tracking-wider">Mint Date & Time</label>
                      {conf.mint_date
                        ? <ConfBadge level={conf.mint_date} />
                        : !form.mint_date && <MissingChip type="mint_date" />}
                    </div>
                    <DateTimePicker value={form.mint_date} onChange={v => set('mint_date', v)} />
                  </div>
                )}

                {/* Mint Price */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider">
                      Mint Price {form.chain === 'bnb' ? '(BNB)' : '(ETH)'}
                    </label>
                    {conf.mint_price
                      ? <ConfBadge level={conf.mint_price} />
                      : !form.mint_price && <MissingChip type="mint_price" />}
                  </div>
                  <input className="input" placeholder="e.g. 0.08  (blank = free / TBA)"
                    value={form.mint_price} onChange={e => set('mint_price', e.target.value)} />
                </div>

                {/* Advanced accordion */}
                <div>
                  <button type="button" onClick={toggleAdvanced}
                    className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors w-full">
                    {advanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    Advanced edit
                    <span className="ml-auto text-muted2 font-normal normal-case">
                      {advanced ? 'hide' : 'chain · contract · mode · gas'}
                    </span>
                  </button>

                  {advanced && (
                    <div className="space-y-4 mt-4 pt-4 border-t border-border/50">

                      {/* Chain + WL Type */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-mono text-muted uppercase tracking-wider">Chain</label>
                            {conf.chain && <ConfBadge level={conf.chain} />}
                          </div>
                          <select className="input" value={form.chain || 'eth'} onChange={e => set('chain', e.target.value)}>
                            {CHAINS.map(c => <option key={c.val} value={c.val}>{c.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">WL Type</label>
                          <select className="input" value={form.wl_type} onChange={e => set('wl_type', e.target.value)}>
                            {WL_TYPES.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Contract Address */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-xs font-mono text-muted uppercase tracking-wider">
                            Contract
                            <span className="text-muted2 normal-case ml-1 font-normal">(for auto-mint)</span>
                          </label>
                          {conf.contract_address
                            ? <ConfBadge level={conf.contract_address} />
                            : !form.contract_address && <MissingChip type="contract_address" />}
                        </div>
                        <input className="input font-mono text-xs" placeholder="0x…"
                          value={form.contract_address} onChange={e => set('contract_address', e.target.value)} />
                      </div>

                      {/* Mint Mode */}
                      <div>
                        <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-2">Mint Mode</label>
                        <div className="grid grid-cols-2 gap-2">
                          {MINT_MODES.map(m => (
                            <button key={m.val} type="button" onClick={() => set('mint_mode', m.val)}
                              className={"p-3 rounded-lg border text-left transition-all " + (
                                form.mint_mode === m.val
                                  ? (m.val === 'auto' ? 'border-green bg-green/8 text-green' : 'border-accent bg-accent/8 text-accent')
                                  : 'border-border2 text-muted hover:border-border'
                              )}>
                              <div className="text-sm font-bold">{m.icon} {m.label}</div>
                              <div className="text-xs opacity-70 mt-0.5">{m.desc}</div>
                            </button>
                          ))}
                        </div>

                        {strikeBlockers.length > 0 && (
                          <div className="mt-2.5 bg-amber-400/8 border border-amber-400/20 rounded-lg p-2.5 space-y-1">
                            <p className="text-[10px] font-mono text-amber-300 uppercase tracking-wider flex items-center gap-1">
                              <Zap size={9} /> Strike Mode — blockers
                            </p>
                            {strikeBlockers.map((b, i) => (
                              <p key={i} className="text-xs text-amber-200/80 flex items-start gap-1.5">
                                <AlertTriangle size={10} className="mt-0.5 shrink-0" />{b}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Max Mint + Gas */}
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Max Mint</label>
                          <input className="input" type="number" min="1" max="20"
                            value={form.max_mint} onChange={e => set('max_mint', parseInt(e.target.value) || 1)} />
                        </div>
                        <div className="col-span-2">
                          <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Gas Limit</label>
                          <input className="input" type="number"
                            value={form.gas_limit} onChange={e => set('gas_limit', parseInt(e.target.value) || 200000)} />
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Notes</label>
                        <textarea className="input resize-none" rows={2}
                          placeholder="Discord role, contract notes, anything useful…"
                          value={form.notes} onChange={e => set('notes', e.target.value)} />
                      </div>

                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex gap-2">
                    <button onClick={onBack} className="btn-ghost flex-1">Back</button>
                    <button
                      onClick={() => handleSubmit(false)}
                      disabled={saving || !form.name.trim()}
                      className="btn-primary flex-1 flex items-center justify-center gap-2"
                    >
                      {saving
                        ? <><Loader size={14} className="animate-spin" /> Saving…</>
                        : <><Shield size={14} /> Add to MintGuard</>}
                    </button>
                  </div>
                  {/* "Save as Needs Review" only when no time AND not live */}
                  {!isLiveNow && !form.mint_date && (
                    <button
                      onClick={() => handleSubmit(true)}
                      disabled={saving || !form.name.trim()}
                      className="w-full btn-ghost text-xs text-amber-300 hover:border-amber-400/40 flex items-center justify-center gap-1.5"
                    >
                      <AlertTriangle size={11} />
                      Save as Needs Review (no time set)
                    </button>
                  )}
                </div>

              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}
