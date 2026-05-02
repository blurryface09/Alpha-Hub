import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Radar, Loader } from 'lucide-react'
import toast from 'react-hot-toast'

export default function AddWalletModal({ onAdd, onClose }) {
  const [form, setForm] = useState({ address: '', label: '', chain: 'eth' })

  const [saving, setSaving] = React.useState(false)
  const handleSubmit = async () => {
    if (!form.address) { toast.error('Enter a wallet address'); return }
    if (!form.address.startsWith('0x')) { toast.error('Address must start with 0x'); return }
    if (form.address.length !== 42) { toast.error(`Address must be 42 chars, got ${form.address.length}`); return }
    setSaving(true)
    try {
      await onAdd(form)
    } catch(err) {
      toast.error('Failed to add wallet: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  // Preset whale addresses for quick add
  const PRESETS = [
    { label: 'Pranksy', address: '0xd387a6e4e84a6c86bd90c158c6028a58cc8ac459', chain: 'eth' },
    { label: 'Punk6529', address: '0xfd22004806a6846ea67ad883356be810f0428793', chain: 'eth' },
    { label: 'Beanie', address: '0x29469395eaf6f95920e59f858042f0e28d98a20b', chain: 'eth' },
  ]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 20 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-md overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Radar size={16} className="text-accent" />
            <span className="font-semibold text-sm">Watch a Wallet</span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Wallet Address *</label>
            <input
              className="input font-mono text-xs"
              placeholder="0x..."
              value={form.address}
              onChange={e => set('address', e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Label</label>
            <input
              className="input"
              placeholder="e.g. Whale #1, Smart Money (required)"
              value={form.label}
              onChange={e => set('label', e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Chain</label>
            <div className="flex gap-2">
              {['eth', 'base'].map(c => (
                <button
                  key={c}
                  onClick={() => set('chain', c)}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-all ${
                    form.chain === c
                      ? c === 'eth' ? 'border-purple bg-purple/10 text-purple' : 'border-accent bg-accent/10 text-accent'
                      : 'border-border2 text-muted hover:border-border'
                  }`}
                >
                  {c === 'eth' ? 'Ethereum' : 'Base'}
                </button>
              ))}
            </div>
          </div>

          {/* Quick add presets */}
          <div>
            <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Quick Add — Known Whales</div>
            <div className="space-y-1.5">
              {PRESETS.map(p => (
                <button
                  key={p.address}
                  onClick={() => setForm({ address: p.address, label: p.label, chain: p.chain })}
                  className="w-full flex items-center justify-between text-xs p-2.5 bg-surface2 border border-border rounded-lg hover:border-accent/40 transition-all text-left"
                >
                  <span className="font-medium">{p.label}</span>
                  <span className="font-mono text-muted">{p.address.slice(0, 12)}...</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
            <button onClick={handleSubmit} disabled={saving} className="btn-primary flex-1 flex items-center justify-center gap-2">
              {saving ? <><Loader size={14} className="animate-spin" /> Saving...</> : <><Radar size={14} /> Start Watching</>}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
