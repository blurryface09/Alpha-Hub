import React from 'react'
import { motion } from 'framer-motion'
import { Zap, AlertTriangle, X } from 'lucide-react'

export default function MintConfirmModal({ project, onConfirm, onCancel }) {
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
                <span className="text-muted">Price</span>
                <span className="font-mono text-accent">{project.mint_price}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted">Quantity</span>
              <span className="font-mono">{project.max_mint}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Gas limit</span>
              <span className="font-mono">{project.gas_limit?.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Contract</span>
              <span className="font-mono text-xs text-accent">
                {project.contract_address?.slice(0, 12)}...
              </span>
            </div>
          </div>

          <div className="flex items-start gap-2 text-xs text-accent3 mb-4 bg-accent3/8 border border-accent3/20 rounded-lg p-3">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            This will sign and broadcast a real transaction. Make sure your wallet is connected and has sufficient funds.
          </div>

          <div className="flex gap-2">
            <button onClick={onCancel} className="btn-ghost flex-1">Cancel</button>
            <button
              onClick={onConfirm}
              className="flex-1 bg-green text-bg font-semibold text-sm px-4 py-2.5 rounded-lg hover:bg-emerald-400 active:scale-95 transition-all flex items-center justify-center gap-2"
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
