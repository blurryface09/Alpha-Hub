import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X, Shield, Loader } from 'lucide-react'
import toast from 'react-hot-toast'
import DateTimePicker from '../shared/DateTimePicker'

const WL_TYPES = [
  { val: 'GTD',     label: 'GTD — Guaranteed spot' },
  { val: 'FCFS',    label: 'FCFS — First come first served' },
  { val: 'PUBLIC',  label: 'Public — Open to everyone' },
  { val: 'RAFFLE',  label: 'Raffle — Random selection' },
  { val: 'UNKNOWN', label: 'Unknown — Not confirmed yet' },
]
const MINT_MODES = [
  { val: 'confirm', label: 'Confirm', icon: '✓', desc: 'App asks you before minting' },
  { val: 'auto', label: 'Auto', icon: '⚡', desc: 'Fires immediately when live' },
]

const STATUS_OPTIONS = ['upcoming', 'live', 'minted', 'missed', 'cancelled']

export default function EditProjectModal({ project, onSave, onClose }) {
  const [form, setForm] = useState({
    name: project.name || '',
    chain: project.chain || 'eth',
    contract_address: project.contract_address || '',
    mint_date: project.mint_date || '',  // stored as UTC ISO, DateTimePicker converts to local on display
    mint_price: project.mint_price || '',
    wl_type: project.wl_type || 'UNKNOWN',
    mint_mode: project.mint_mode || 'confirm',
    max_mint: project.max_mint || 1,
    gas_limit: project.gas_limit || 200000,
    notes: project.notes || '',
    status: project.status || 'upcoming',
  })
  const [loading, setLoading] = useState(false)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Project name is required'); return }
    setLoading(true)
    try {
      await onSave({
        ...form,
        gas_limit: parseInt(form.gas_limit) || 200000,
        max_mint: parseInt(form.max_mint) || 1,
        contract_address: form.contract_address?.trim() || null,
        mint_date: form.mint_date || null,
        mint_price: form.mint_price?.trim() || null,
        notes: form.notes?.trim() || null,
      })
    } catch(err) {
      toast.error('Update failed: ' + err.message)
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
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-accent" />
            <h2 className="font-bold text-sm">Edit Project</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Project Name *</label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-3">
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
            <div>
              <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Status</label>
              <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
            </div>
          </div>

          <DateTimePicker
            value={form.mint_date}
            onChange={val => set('mint_date', val)}
          />

          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Mint Price</label>
            <input className="input" placeholder="e.g. 0.08 ETH" value={form.mint_price} onChange={e => set('mint_price', e.target.value)} />
          </div>

          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Contract Address</label>
            <input className="input font-mono text-xs" placeholder="0x..." value={form.contract_address} onChange={e => set('contract_address', e.target.value)} />
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
            <textarea className="input resize-none" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
            <button onClick={handleSave} disabled={loading} className="btn-primary flex-1 flex items-center justify-center gap-2">
              {loading ? <><Loader size={14} className="animate-spin" /> Saving...</> : <><Shield size={14} /> Save Changes</>}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
