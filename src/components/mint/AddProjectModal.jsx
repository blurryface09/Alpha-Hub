import React, { useCallback, useState } from 'react'
import { X, Link2, Shield, Loader, Sparkles } from 'lucide-react'
import toast from 'react-hot-toast'
import { extractProjectMetadata } from '../../lib/ai'
import { friendlyError } from '../../lib/errors'
import { getAuthToken } from '../../lib/supabase'
import DateTimePicker from '../shared/DateTimePicker'

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

const WL_TYPES = [
  { val: 'GTD',     label: 'GTD',     desc: 'Guaranteed spot' },
  { val: 'FCFS',    label: 'FCFS',    desc: 'First come first served' },
  { val: 'PUBLIC',  label: 'Public',  desc: 'Open to everyone' },
  { val: 'RAFFLE',  label: 'Raffle',  desc: 'Random selection' },
  { val: 'UNKNOWN', label: 'Unknown', desc: 'Not confirmed yet' },
]

const MINT_MODES = [
  { val: 'confirm', label: 'Fast Mint', icon: '✓', desc: 'Prepared wallet confirmation' },
  { val: 'auto',    label: 'Strike Mode',    icon: '⚡', desc: 'Alpha Vault auto execution' },
]
const CHAIN_IDS = { eth: 1, base: 8453, apechain: 33139, solana: 0 }

export default function AddProjectModal({ onAdd, onClose }) {
  const [step, setStep] = useState(1)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [detectingTime, setDetectingTime] = useState(false)
  const [detectedTime, setDetectedTime] = useState(null)
  const [form, setForm] = useState({
    name: '',
    source_url: '',
    source_type: 'website',
    chain: 'eth',
    contract_address: '',
    mint_date: '',
    mint_price: '',
    wl_type: 'UNKNOWN',
    mint_mode: 'confirm',
    automint_enabled: false,
    auto_beta_ack: false,
    max_mint: 1,
    gas_limit: 200000,
    max_mint_price: '',
    max_gas_fee: '',
    max_total_spend: '',
    mint_time_source: 'manual',
    mint_time_confidence: 'manual',
    mint_time_confirmed: false,
    mint_time_confirmed_at: null,
    notes: '',
  })

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const scanMintTime = useCallback(async (sourceForm, { quiet = false } = {}) => {
    if (!sourceForm.contract_address?.trim() && !sourceForm.source_url?.trim()) {
      if (!quiet) toast.error('Add a contract address or mint page URL first')
      return null
    }
    setDetectingTime(true)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before scanning')
      const res = await fetch('/api/calendar/mint-time', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contractAddress: sourceForm.contract_address?.trim() || null,
          chainId: CHAIN_IDS[sourceForm.chain] || 1,
          mintUrl: sourceForm.source_url || url || null,
          projectName: sourceForm.name,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Mint time scan failed')
      if (!data.detected) {
        setDetectedTime(null)
        if (!quiet) toast('Could not detect launch time. Paste official mint link or enter manually.')
        return null
      }
      setDetectedTime(data)
      if (!quiet) toast.success('Mint time detected. Confirm or edit it before saving.')
      return data
    } catch (error) {
      if (!quiet) toast.error(friendlyError(error, 'Could not detect launch time. Paste official mint link or enter manually.'))
      return null
    } finally {
      setDetectingTime(false)
    }
  }, [url])

  const handleUrlSubmit = async () => {
    if (!url.trim()) { toast.error('Paste a URL first'); return }
    setLoading(true)
    try {
      // Try AI-powered extraction first
      const meta = await extractProjectMetadata(url)
      const autoFill = {
        source_url: url,
        source_type: meta.source_type || 'website',
        chain: meta.chain !== 'unknown' ? (meta.chain || 'eth') : 'eth',
        notes: meta.notes || '',
      }
      if (meta.name) autoFill.name = meta.name

      // Fallback string parsing if AI didn't get a name
      if (!autoFill.name) {
        if (url.includes('twitter.com') || url.includes('x.com')) {
          const handle = url.match(/(?:twitter|x)\.com\/([^/?#]+)/)
          if (handle) autoFill.name = handle[1]
          autoFill.source_type = 'twitter'
        } else if (url.includes('opensea.io')) {
          const slug = url.match(/opensea\.io\/collection\/([^/?#]+)/)
          if (slug) autoFill.name = slug[1].replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          autoFill.source_type = 'opensea'
        } else {
          const parts = url.replace(/https?:\/\//, '').split('/')
          autoFill.name = parts[parts.length - 1]?.replace(/-/g, ' ') || parts[0]
        }
      }

      const nextForm = { ...form, ...autoFill }
      setForm(nextForm)
      setStep(2)
      scanMintTime(nextForm, { quiet: true })
    } catch (e) {
      // Silent fallback
      const nextForm = { ...form, source_url: url }
      setForm(nextForm)
      setStep(2)
      scanMintTime(nextForm, { quiet: true })
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast.error('Project name is required'); return }
    if (form.mint_mode === 'auto' && !form.contract_address?.trim()) {
      toast.error('Strike Mode needs a contract address')
      return
    }
    if (form.mint_mode === 'auto' && !form.auto_beta_ack) {
      toast.error('Confirm that you understand Strike Mode can execute real blockchain transactions')
      return
    }
    if (form.mint_mode === 'auto' && form.mint_date && !form.mint_time_confirmed) {
      toast.error('Confirm the mint time before enabling Strike Mode')
      return
    }
    const rawContract = form.contract_address?.trim() || ''
    const rawMintPrice = form.mint_price?.trim() || ''
    const priceLooksLikeAddress = ETH_ADDRESS_RE.test(rawMintPrice)
    const cleanForm = {
      ...form,
      gas_limit: parseInt(form.gas_limit) || 200000,
      max_mint: parseInt(form.max_mint) || 1,
      automint_enabled: form.mint_mode === 'auto' && form.auto_beta_ack,
      contract_address: rawContract || (priceLooksLikeAddress ? rawMintPrice : null),
      mint_date: form.mint_date || null,
      mint_price: priceLooksLikeAddress ? null : (rawMintPrice || null),
      max_mint_price: form.max_mint_price?.trim() || null,
      max_gas_fee: form.max_gas_fee?.trim() || null,
      max_total_spend: form.max_total_spend?.trim() || null,
      mint_time_source: form.mint_date ? (form.mint_time_source || 'manual') : null,
      mint_time_confidence: form.mint_date ? (form.mint_time_confidence || 'manual') : null,
      mint_time_confirmed: Boolean(form.mint_date),
      mint_time_confirmed_at: form.mint_date ? (form.mint_time_confirmed_at || new Date().toISOString()) : null,
      notes: form.notes?.trim() || null,
    }
    setLoading(true)
    try {
      await onAdd(cleanForm)
    } catch(err) {
      toast.error(friendlyError(err, 'Could not save this project. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  const detectMintTime = async () => {
    await scanMintTime(form)
  }

  const confirmDetectedTime = () => {
    if (!detectedTime?.mintDate) return
    setForm(f => ({
      ...f,
      mint_date: detectedTime.mintDate,
      mint_time_source: detectedTime.source,
      mint_time_confidence: detectedTime.confidence,
      mint_time_confirmed: true,
      mint_time_confirmed_at: new Date().toISOString(),
    }))
    toast.success('Mint time confirmed')
  }

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-surface border border-border rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent" />
            <h2 className="font-bold text-sm">
              {step === 1 ? 'Add Alpha' : 'Review and save'}
            </h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </div>

        <div className="p-5">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <div className="rounded-2xl border border-accent/20 bg-accent/8 p-3 mb-4">
                  <div className="text-sm font-bold text-text">What are you tracking?</div>
                  <p className="text-xs text-muted mt-1">Start with a mint page, OpenSea link, X post, or official site. You can edit every detail before saving.</p>
                </div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Official link</label>
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="OpenSea, Zora, mint page, website, or X link"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleUrlSubmit()}
                    autoFocus
                  />
                  <button
                    onClick={handleUrlSubmit}
                    disabled={loading}
                    className="btn-primary px-4 flex items-center gap-2"
                  >
                    {loading ? <Loader size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    {loading ? '' : 'Scan'}
                  </button>
                </div>
                <p className="text-xs text-muted mt-2">Alpha Hub will try to detect name, chain, contract, and launch time. You always confirm before saving.</p>
              </div>
              <div className="flex justify-end">
                <button onClick={() => setStep(2)} className="text-xs text-accent hover:underline">
                  Enter details yourself
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Project name *</label>
                <input className="input" placeholder="e.g. Slimez, BasePaint, Farcaster drop..." value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Chain</label>
                  <select className="input" value={form.chain} onChange={e => set('chain', e.target.value)}>
                    <option value="eth">Ethereum</option>
                    <option value="base">Base</option>
                    <option value="bnb">BNB Chain</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Access type</label>
                  <select className="input" value={form.wl_type} onChange={e => set('wl_type', e.target.value)}>
                    {WL_TYPES.map(t => <option key={t.val} value={t.val}>{t.label} — {t.desc}</option>)}
                  </select>
                </div>
              </div>

              <DateTimePicker
                value={form.mint_date}
                onChange={val => setForm(f => ({
                  ...f,
                  mint_date: val,
                  mint_time_source: 'manual',
                  mint_time_confidence: 'manual',
                  mint_time_confirmed: Boolean(val),
                  mint_time_confirmed_at: val ? new Date().toISOString() : null,
                }))}
              />
              <div className="flex gap-2">
                <button onClick={detectMintTime} disabled={detectingTime} className="btn-ghost flex items-center gap-2 text-xs">
                  {detectingTime ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {detectingTime ? 'Scanning...' : 'Find launch time'}
                </button>
                {detectedTime && (
                  <button onClick={confirmDetectedTime} className="btn-primary text-xs">
                    Confirm detected time
                  </button>
                )}
              </div>
              {detectedTime && (
                <div className="rounded-lg border border-accent/20 bg-accent/8 p-3 text-xs text-muted space-y-1">
                  <div className="font-mono text-accent">Possible launch time found</div>
                  <div>Local: {new Date(detectedTime.mintDate).toLocaleString()}</div>
                  <div>UTC: {new Date(detectedTime.mintDate).toISOString()}</div>
                  <div>Source: {detectedTime.source}</div>
                  <div>Confidence: {detectedTime.confidence}</div>
                  {detectedTime.confidence !== 'high' && (
                    <div className="text-amber-200">Please verify this time from the official project source.</div>
                  )}
                </div>
              )}
              {form.mint_date && (
                <div className="rounded-lg border border-accent/20 bg-accent/8 p-3 text-xs text-muted">
                  <div className="font-mono text-accent mb-1">{form.mint_time_source === 'manual' ? 'Launch time entered by you' : 'Launch time confirmed'}</div>
                  <div>Local: {new Date(form.mint_date).toLocaleString()}</div>
                  <div>UTC: {new Date(form.mint_date).toISOString()}</div>
                </div>
              )}

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Price</label>
                <input className="input" placeholder="e.g. 0.08" value={form.mint_price} onChange={e => set('mint_price', e.target.value)} />
              </div>

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Contract address <span className="text-muted2">(optional, needed for mint assist)</span></label>
                <input className="input font-mono text-xs" placeholder="0x..." value={form.contract_address} onChange={e => set('contract_address', e.target.value)} />
              </div>

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">How should Alpha Hub help?</label>
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
                {form.mint_mode === 'auto' && (
                  <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-3">
                    <p>Strike Mode can execute real blockchain transactions through Alpha Vault. Use an isolated burner wallet and set max spend limits.</p>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={form.auto_beta_ack}
                        onChange={e => set('auto_beta_ack', e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>I understand Strike Mode may execute real blockchain transactions.</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Quantity</label>
                  <input className="input" type="number" min="1" max="20" value={form.max_mint} onChange={e => set('max_mint', parseInt(e.target.value) || 1)} />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Gas safety limit</label>
                  <input className="input" type="number" value={form.gas_limit} onChange={e => set('gas_limit', parseInt(e.target.value) || 200000)} />
                </div>
              </div>
              {form.mint_mode === 'auto' && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Max Mint ETH</label>
                    <input className="input" placeholder="0.05" value={form.max_mint_price} onChange={e => set('max_mint_price', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Max Gas ETH</label>
                    <input className="input" placeholder="0.01" value={form.max_gas_fee} onChange={e => set('max_gas_fee', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Max Total ETH</label>
                    <input className="input" placeholder="0.06" value={form.max_total_spend} onChange={e => set('max_total_spend', e.target.value)} />
                  </div>
                </div>
              )}

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Notes</label>
                <textarea className="input resize-none" rows={2} placeholder="Role needed, mint rules, official source, or anything you want to remember..." value={form.notes} onChange={e => set('notes', e.target.value)} />
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={() => setStep(1)} className="btn-ghost flex-1">Back</button>
                <button onClick={handleSubmit} disabled={loading} className="btn-primary flex-1 flex items-center justify-center gap-2">
                  {loading ? <><Loader size={14} className="animate-spin" /> Saving...</> : <><Shield size={14} /> Save to My Mints</>}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
