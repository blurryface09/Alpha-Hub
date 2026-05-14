import React, { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Shield, Loader, Sparkles, AlertTriangle, CheckCircle, Info, ChevronRight } from 'lucide-react'
import toast from 'react-hot-toast'
import DateTimePicker from '../shared/DateTimePicker'

// ── Confidence badge ─────────────────────────────────────────────────────────
function ConfBadge({ level }) {
  if (level === 'api_verified') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-green px-1.5 py-0.5 bg-green/10 rounded">
      <CheckCircle size={9} /> Verified
    </span>
  )
  if (level === 'url_extracted') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-blue-400 px-1.5 py-0.5 bg-blue-400/10 rounded">
      <Info size={9} /> Extracted
    </span>
  )
  if (level === 'ai_inferred') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-yellow-400 px-1.5 py-0.5 bg-yellow-400/10 rounded">
      <Sparkles size={9} /> AI guess
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-red-400 px-1.5 py-0.5 bg-red-400/10 rounded">
      <AlertTriangle size={9} /> Fill manually
    </span>
  )
}

// ── Label wrapper used in the review card ────────────────────────────────────
function ReviewRow({ label, value, conf, placeholder = '—' }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted w-24 shrink-0">{label}</span>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={`text-xs font-mono truncate ${!value ? 'text-muted italic' : 'text-text'}`}>
          {value || placeholder}
        </span>
        <ConfBadge level={conf} />
      </div>
    </div>
  )
}

const WL_TYPES = [
  { val: 'GTD',     label: 'GTD',     desc: 'Guaranteed spot' },
  { val: 'FCFS',    label: 'FCFS',    desc: 'First come first served' },
  { val: 'PUBLIC',  label: 'Public',  desc: 'Open to everyone' },
  { val: 'RAFFLE',  label: 'Raffle',  desc: 'Random selection' },
  { val: 'UNKNOWN', label: 'Unknown', desc: 'Not confirmed yet' },
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

// ── Default form state ────────────────────────────────────────────────────────
const defaultForm = () => ({
  name:             '',
  source_url:       '',
  source_type:      'website',
  chain:            'eth',
  contract_address: '',
  mint_date:        '',
  mint_price:       '',
  wl_type:          'UNKNOWN',
  mint_mode:        'confirm',
  max_mint:         1,
  gas_limit:        200000,
  notes:            '',
})

export default function AddProjectModal({ onAdd, onClose }) {
  const [step,       setStep]       = useState(1)   // 1=paste, 2=review+fill
  const [url,        setUrl]        = useState('')
  const [loading,    setLoading]    = useState(false)
  const [meta,       setMeta]       = useState(null) // raw API response
  const [form,       setForm]       = useState(defaultForm)
  const [saving,     setSaving]     = useState(false)
  const urlRef = useRef(null)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  // ── Step 1: analyse URL ───────────────────────────────────────────────────
  const handleAnalyse = async () => {
    const trimmed = url.trim()
    if (!trimmed) { toast.error('Paste a URL first'); return }
    setLoading(true)
    try {
      const resp = await fetch(`/api/metadata?url=${encodeURIComponent(trimmed)}`)
      const data = await resp.json()

      setMeta(data)
      setForm({
        ...defaultForm(),
        source_url:       trimmed,
        name:             data.name             || '',
        source_type:      data.source_type      || 'website',
        chain:            data.chain            || 'eth',
        contract_address: data.contract_address || '',
        mint_price:       data.mint_price       || '',
        notes:            data.notes            || '',
      })
      setStep(2)
    } catch {
      // Fallback: simple URL parsing, skip to form anyway
      const m = trimmed.match(/(?:twitter|x)\.com\/([^/?#]+)/)
      const os = trimmed.match(/opensea\.io\/collection\/([^/?#]+)/)
      const name = m ? m[1] : os ? os[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : ''
      setForm({ ...defaultForm(), source_url: trimmed, name })
      setMeta(null)
      setStep(2)
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2: save ──────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!form.name.trim()) { toast.error('Project name is required'); return }
    const cleanForm = {
      ...form,
      gas_limit:        parseInt(form.gas_limit)  || 200000,
      max_mint:         parseInt(form.max_mint)   || 1,
      contract_address: form.contract_address?.trim() || null,
      mint_date:        form.mint_date            || null,
      mint_price:       form.mint_price?.trim()   || null,
      notes:            form.notes?.trim()        || null,
    }
    setSaving(true)
    try {
      await onAdd(cleanForm)
    } catch (err) {
      toast.error('Save failed: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const conf = meta?.confidence || {}
  const missing = meta?.missing_fields || []

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1,    y: 0  }}
        exit={{    opacity: 0, scale: 0.95 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent" />
            <h2 className="font-bold text-sm">
              {step === 1 ? 'Add Alpha' : form.name || 'New Project'}
            </h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1"><X size={16} /></button>
        </div>

        <div className="p-5">
          <AnimatePresence mode="wait">
            {/* ── STEP 1: Paste URL ── */}
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{    opacity: 0, x: -10 }}
                className="space-y-4"
              >
                <div>
                  <p className="text-xs text-muted mb-3">
                    Paste any URL — OpenSea, Zora, Magic Eden, Twitter, or a project website.
                    We'll extract the details automatically.
                  </p>
                  <div className="flex gap-2">
                    <input
                      ref={urlRef}
                      className="input flex-1"
                      placeholder="https://opensea.io/collection/..."
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAnalyse()}
                      autoFocus
                    />
                    <button
                      onClick={handleAnalyse}
                      disabled={loading}
                      className="btn-primary px-4 flex items-center gap-2 shrink-0"
                    >
                      {loading
                        ? <Loader size={14} className="animate-spin" />
                        : <><Sparkles size={14} /><span>Analyse</span></>
                      }
                    </button>
                  </div>
                  <p className="text-xs text-muted mt-2 opacity-60">
                    Supports: OpenSea · Zora · Magic Eden · Twitter/X · Any website
                  </p>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={() => { setMeta(null); setForm(defaultForm()); setStep(2) }}
                    className="text-xs text-accent hover:underline flex items-center gap-1"
                  >
                    Skip — fill manually <ChevronRight size={12} />
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── STEP 2: Review + Fill ── */}
            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{    opacity: 0, x: 10 }}
                className="space-y-5"
              >
                {/* Intelligence Report card */}
                {meta && (
                  <div className="bg-bg border border-border/60 rounded-xl p-3">
                    <p className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Sparkles size={9} className="text-accent" /> Intelligence Report
                    </p>
                    <ReviewRow label="Name"     value={meta.name}             conf={conf.name}             placeholder="Not detected" />
                    <ReviewRow label="Chain"    value={meta.chain?.toUpperCase()} conf={conf.chain}         placeholder="Not detected" />
                    <ReviewRow label="Contract" value={meta.contract_address ? `${meta.contract_address.slice(0,6)}...${meta.contract_address.slice(-4)}` : null} conf={conf.contract_address} placeholder="Not detected" />
                    <ReviewRow label="Mint Date" value={null}                 conf={conf.mint_date}        placeholder="Fill below" />
                    <ReviewRow label="Price"    value={meta.mint_price ? `${meta.mint_price} ETH` : null} conf={conf.mint_price} placeholder="Fill below" />
                    {meta.warning && (
                      <div className="mt-2 flex items-start gap-1.5 text-yellow-400 bg-yellow-400/8 rounded-lg p-2">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <span className="text-xs">{meta.warning}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Missing fields callout */}
                {missing.length > 0 && (
                  <div className="flex items-start gap-2 bg-accent/8 border border-accent/20 rounded-lg px-3 py-2">
                    <AlertTriangle size={13} className="text-accent mt-0.5 shrink-0" />
                    <p className="text-xs text-muted">
                      <span className="text-text font-medium">Fill in: </span>
                      {missing.join(', ')}
                    </p>
                  </div>
                )}

                {/* ── Form fields ── */}

                {/* Name */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider">Project Name *</label>
                    {conf.name && <ConfBadge level={conf.name} />}
                  </div>
                  <input
                    className={`input ${missing.includes('name') ? 'border-red-400/50' : ''}`}
                    placeholder="e.g. CryptoSkulls"
                    value={form.name}
                    onChange={e => set('name', e.target.value)}
                    autoFocus
                  />
                </div>

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
                      {WL_TYPES.map(t => <option key={t.val} value={t.val}>{t.label} — {t.desc}</option>)}
                    </select>
                  </div>
                </div>

                {/* Mint Date */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider">
                      Mint Date & Time
                      {missing.includes('mint_date') && <span className="text-red-400 ml-1">*</span>}
                    </label>
                    <ConfBadge level="missing" />
                  </div>
                  <DateTimePicker
                    value={form.mint_date}
                    onChange={utcStr => set('mint_date', utcStr)}
                  />
                </div>

                {/* Mint Price */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider">Mint Price (ETH)</label>
                    {conf.mint_price && <ConfBadge level={conf.mint_price} />}
                  </div>
                  <input
                    className="input"
                    placeholder="e.g. 0.08"
                    value={form.mint_price}
                    onChange={e => set('mint_price', e.target.value)}
                  />
                </div>

                {/* Contract Address */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider">
                      Contract Address
                      <span className="text-muted2 normal-case ml-1">(needed for auto-mint)</span>
                    </label>
                    {conf.contract_address && <ConfBadge level={conf.contract_address} />}
                  </div>
                  <input
                    className={`input font-mono text-xs ${missing.includes('contract_address') ? 'border-yellow-400/40' : ''}`}
                    placeholder="0x..."
                    value={form.contract_address}
                    onChange={e => set('contract_address', e.target.value)}
                  />
                </div>

                {/* Mint Mode */}
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-2">Mint Mode</label>
                  <div className="grid grid-cols-2 gap-2">
                    {MINT_MODES.map(m => (
                      <button
                        key={m.val}
                        onClick={() => set('mint_mode', m.val)}
                        className={"p-3 rounded-lg border text-left transition-all " + (
                          form.mint_mode === m.val
                            ? (m.val === 'auto' ? 'border-green bg-green/8 text-green' : 'border-accent bg-accent/8 text-accent')
                            : 'border-border2 text-muted hover:border-border'
                        )}
                      >
                        <div className="text-sm font-bold">{m.icon} {m.label}</div>
                        <div className="text-xs opacity-70 mt-0.5">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                  {form.mint_mode === 'auto' && !form.contract_address?.trim() && (
                    <p className="text-xs text-yellow-400 mt-1.5 flex items-center gap-1">
                      <AlertTriangle size={11} /> Auto-mint needs a contract address to fire
                    </p>
                  )}
                </div>

                {/* Max Mint + Gas */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Max Mint</label>
                    <input
                      className="input"
                      type="number" min="1" max="20"
                      value={form.max_mint}
                      onChange={e => set('max_mint', parseInt(e.target.value) || 1)}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Gas Limit</label>
                    <input
                      className="input"
                      type="number"
                      value={form.gas_limit}
                      onChange={e => set('gas_limit', parseInt(e.target.value) || 200000)}
                    />
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Notes</label>
                  <textarea
                    className="input resize-none"
                    rows={2}
                    placeholder="Discord role, contract notes, anything useful..."
                    value={form.notes}
                    onChange={e => set('notes', e.target.value)}
                  />
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setStep(1)} className="btn-ghost flex-1">Back</button>
                  <button
                    onClick={handleSubmit}
                    disabled={saving}
                    className="btn-primary flex-1 flex items-center justify-center gap-2"
                  >
                    {saving
                      ? <><Loader size={14} className="animate-spin" /> Saving...</>
                      : <><Shield size={14} /> Add to MintGuard</>
                    }
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}
