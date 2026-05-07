import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Zap, AlertTriangle, X, Flame } from 'lucide-react'

export default function MintConfirmModal({ project, onConfirm, onCancel }) {
  const [gas, setGas] = useState(project.gas_limit || 200000)
  const gasWarning = gas < 21000 ? 'Too low — minimum is 21,000' : gas > 2_000_000 ? 'Very high — double-check this value' : null

  const price = parseFloat(project.mint_price) || 0
  const qty = parseInt(project.max_mint) || 1
  const estimatedTotal = price > 0 ? (price * qty).toFixed(4) : null
  const symbol = project.chain === 'bnb' ? 'BNB' : 'ETH'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 20 }}
        className="bg-surface border border-green/30 rounded-2xl w-full max-w-sm overflow-hidden glow-green"
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-green" />
            <span className="font-semibold text-sm text-green">Confirm Mint</span>
          </div>
          <button onClick={onCancel} className="text-muted hover:text-text"><X size={16} /></button>
        </div>

        <div className="p-5">
          <div className="bg-surface2 rounded-xl border border-border p-4 mb-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Project</span>
              <span className="font-semibold">{project.name}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Chain</span>
              <span className="font-mono">{project.chain?.toUpperCase()}</span>
            </div>
            {project.mint_price && (
              <div className="flex justify-between text-sm">
                <span className="text-muted">Price per mint</span>
                <span className="font-mono text-green font-semibold">{project.mint_price} {symbol}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted">Quantity</span>
              <span className="font-mono">{qty}</span>
            </div>
            {estimatedTotal && (
              <div className="flex justify-between text-sm border-t border-border pt-2 mt-1">
                <span className="text-muted font-medium">Est. Total</span>
                <span className="font-mono font-bold text-accent">{estimatedTotal} {symbol}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted">Contract</span>
              <span className="font-mono text-xs text-accent">
                {project.contract_address?.slice(0, 10)}...{project.contract_address?.slice(-6)}
              </span>
            </div>
          </div>

          {/* Editable gas limit */}
          <div className="mb-4">
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5 flex items-center gap-1.5">
              <Flame size={11} className="text-accent3" />
              Gas Limit
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                className="input flex-1 font-mono text-sm"
                value={gas}
                onChange={e => setGas(parseInt(e.target.value) || 200000)}
                min={21000}
                max={2000000}
              />
              <button
                onClick={() => setGas(200000)}
                className="btn-ghost text-xs px-3"
              >
                Reset
              </button>
            </div>
            {gasWarning
              ? <p className="text-[10px] text-accent3 mt-1 font-semibold">⚠ {gasWarning}</p>
              : <p className="text-[10px] text-muted mt-1">Default: 200,000 — increase if tx fails with out-of-gas</p>
            }
          </div>

          <div className="flex items-start gap-2 text-xs text-accent3 mb-4 bg-accent3/8 border border-accent3/20 rounded-lg p-3">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            This will sign and broadcast a real transaction. Make sure your wallet is connected and has sufficient funds.
          </div>

          <div className="flex gap-2">
            <button onClick={onCancel} className="btn-ghost flex-1">Cancel</button>
            <button
              onClick={() => onConfirm(gas)}
              disabled={gas < 21000}
              className="flex-1 bg-green text-bg font-semibold text-sm px-4 py-2.5 rounded-lg hover:bg-emerald-400 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Zap size={14} />
              Execute Mint
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
