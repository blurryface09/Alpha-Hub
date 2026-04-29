import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Link2, Calendar, Zap, Shield, Loader } from 'lucide-react'
import toast from 'react-hot-toast'

const WL_TYPES = [
  { val: 'GTD', label: 'GTD', desc: 'Guaranteed spot' },
  { val: 'FCFS', label: 'FCFS', desc: 'First come first served' },
  { val: 'RAFFLE', label: 'Raffle', desc: 'Random selection' },
  { val: 'UNKNOWN', label: 'Unknown', desc: 'Not confirmed yet' },
]

const MINT_MODES = [
  { val: 'confirm', label: 'Confirm', icon: '✓', desc: 'App asks you before minting' },
  { val: 'auto', label: 'Auto', icon: '⚡', desc: 'Fires immediately when live' },
]

export default function AddProjectModal({ onAdd, onClose }) {
  const [step, setStep] = useState(1)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
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
    max_mint: 1,
    gas_limit: 200000,
    notes: '',
  })

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleUrlSubmit = async () => {
    if (!url.trim()) { toast.error('Paste a URL first'); return }
    setLoading(true)
    let source_type = 'website'
    let autoFill = {}
    if (url.includes('twitter.com') || url.includes('x.com')) {
      source_type = 'twitter'
      const handle = url.match(/(?:twitter|x)\.com\/([^/?#]+)/)
      if (handle) autoFill.name = handle[1]
    } else if (url.includes('opensea.io')) {
      source_type = 'opensea'
      const slug = url.match(/opensea\.io\/collection\/([^/?#]+)/)
      if (slug) {
        autoFill.name = slug[1].replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      }
    } else {
      const parts = url.replace(/https?:\/\//, '').split('/')
      if (parts.length > 1) autoFill.name = parts[parts.length - 1].replace(/-/g, ' ')
    }
    setForm(f => ({ ...f, source_url: url, source_type, chain: 'eth', ...autoFill }))
    setLoading(false)
    setStep(2)
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast.error('Project name is required'); return }
    const cleanForm = {
      ...form,
      gas_limit: parseInt(form.gas_limit) || 200000,
      max_mint: parseInt(form.max_mint) || 1,
      contract_address: form.contract_address?.trim() || null,
      mint_date: form.mint_date || null,
      mint_price: form.mint_price?.trim() || null,
      notes: form.notes?.trim() || null,
    }
    setLoading(true)
    try {
      await onAdd(cleanForm)
    } catch(err) {
      toast.error('Save failed: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent" />
            <h2 className="font-bold text-sm">
              {step === 1 ? 'Add WL Project' : 'Project Details'}
            </h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </div>

        <div className="p-5">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Project URL</label>
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="https://twitter.com/project or opensea.io/..."
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
                    {loading ? <Loader size={14} className="animate-spin" /> : <Link2 size={14} />}
                    {loading ? '' : 'Next'}
                  </button>
                </div>
                <p className="text-xs text-muted mt-2">Paste any link -- OpenSea, Twitter/X, or project website</p>
              </div>
              <div className="flex justify-end">
                <button onClick={() => setStep(2)} className="text-xs text-accent hover:underline">
                  Skip -- enter manually
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Project Name *</label>
                <input className="input" placeholder="e.g. CryptoSkulls" value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Chain</label>
                  <select className="input" value={form.chain} onChange={e => set('chain', e.target.value)}>
                    <option value="eth">Ethereum</option>
                    <option value="base">Base</option>
                    <option value="bnb">BNB</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">WL Type</label>
                  <select className="input" value={form.wl_type} onChange={e => set('wl_type', e.target.value)}>
                    {WL_TYPES.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Mint Date</label>
                  <input className="input" type="datetime-local" value={form.mint_date} onChange={e => set('mint_date', e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Mint Price</label>
                  <input className="input" placeholder="e.g. 0.08 ETH" value={form.mint_price} onChange={e => set('mint_price', e.target.value)} />
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Contract Address (Optional)</label>
                <input className="input font-mono text-xs" placeholder="0x... (add when known for auto-mint)" value={form.contract_address} onChange={e => set('contract_address', e.target.value)} />
              </div>

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Mint Mode</label>
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
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Max Mint</label>
                  <input className="input" type="number" min="1" max="20" value={form.max_mint} onChange={e => set('max_mint', parseInt(e.target.value) || 1)} />
                </div>
                <div>
                  <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Gas Limit</label>
                  <input className="input" type="number" value={form.gas_limit} onChange={e => set('gas_limit', parseInt(e.target.value) || 200000)} />
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Notes</label>
                <textarea className="input resize-none" rows={2} placeholder="Any notes about this project..." value={form.notes} onChange={e => set('notes', e.target.value)} />
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={() => setStep(1)} className="btn-ghost flex-1">Back</button>
                <button onClick={handleSubmit} disabled={loading} className="btn-primary flex-1 flex items-center justify-center gap-2">
                  {loading ? <><Loader size={14} className="animate-spin" /> Saving...</> : <><Shield size={14} /> Add to MintGuard</>}
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}
