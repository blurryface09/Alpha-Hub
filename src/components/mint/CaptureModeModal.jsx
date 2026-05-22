import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Database, ExternalLink, Loader, CheckCircle, AlertCircle, RefreshCw, ChevronRight, Zap } from 'lucide-react'
import toast from 'react-hot-toast'
import { getAuthToken } from '../../lib/supabase'
import { classifyProtocol, detectProofShape, buildProfileFromCapture, PROTOCOL_LABELS } from '../../lib/mintProfiles'

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(a) {
  if (!a || a.length < 10) return a || '—'
  return `${a.slice(0, 8)}…${a.slice(-4)}`
}

function shortData(d) {
  if (!d) return '—'
  return d.slice(0, 18) + (d.length > 18 ? '…' : '')
}

function wei2eth(v) {
  if (!v || v === '0') return 'Free'
  const n = Number(v)
  if (!n) return 'Free'
  return `${(n / 1e18).toFixed(5)} ETH`
}

// ── Capture state machine ────────────────────────────────────────────────────
//
//  idle → loading (iframe set) → capturing (page loaded) → captured (tx received) → saving → saved
//                                                         ↘ error (page blocked/load fail)

const STEP_LABELS = {
  idle:      null,
  loading:   'Loading mint page…',
  capturing: 'Connect wallet on the mint page, then click Mint to capture the execution path.',
  captured:  null,
  saving:    'Saving profile…',
  saved:     'Profile saved.',
  error:     null,
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CaptureModeModal({ project, onClose, onSaved }) {
  const [url, setUrl] = useState(project?.source_url || project?.mint_url || '')
  const [step, setStep] = useState('idle')
  const [capturedTx, setCapturedTx] = useState(null)
  const [classified, setClassified] = useState(null)
  const [frameError, setFrameError] = useState(null)
  const [proxyUrl, setProxyUrl] = useState(null)
  const iframeRef = useRef(null)
  const token = useRef(null)

  // Fetch auth token once
  useEffect(() => {
    getAuthToken().then(t => { token.current = t })
  }, [])

  // Listen for captured tx from iframe
  useEffect(() => {
    function handleMessage(e) {
      const data = e.data
      if (!data || data.__type !== 'AH_CAPTURE_TX') return
      const tx = data.tx
      if (!tx) return
      const proto = classifyProtocol(tx.to, tx.data)
      const proofShape = detectProofShape(tx.data)
      setClassified({ ...proto, proofShape })
      setCapturedTx(tx)
      setStep('captured')
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  function loadPage() {
    if (!url.trim()) return
    setStep('loading')
    setFrameError(null)
    setCapturedTx(null)
    setClassified(null)
    const encoded = encodeURIComponent(url.trim())
    const t = token.current || ''
    setProxyUrl(`/api/capture/proxy?url=${encoded}&token=${t}`)
  }

  function handleIframeLoad() {
    if (step === 'loading') setStep('capturing')
  }

  function handleIframeError() {
    setFrameError('Could not load the mint page. The site may block embedding. Use manual capture below.')
    setStep('error')
  }

  async function saveProfile() {
    if (!capturedTx || !project) return
    setStep('saving')
    try {
      const t = token.current || (await getAuthToken())
      const profile = buildProfileFromCapture(capturedTx, project)
      const res = await fetch('/api/capture/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify(profile),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
      setStep('saved')
      toast.success('Execution profile saved — Strike pre-armed')
      onSaved?.(data.profile)
    } catch (err) {
      toast.error(err.message)
      setStep('captured')
    }
  }

  function reset() {
    setStep('idle')
    setCapturedTx(null)
    setClassified(null)
    setProxyUrl(null)
    setFrameError(null)
  }

  const protocolLabel = classified ? (PROTOCOL_LABELS[classified.protocol] || classified.protocol) : null
  const isBusy = step === 'loading' || step === 'saving'
  const showIframe = proxyUrl && step !== 'error' && step !== 'idle'

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={{ duration: 0.18 }}
          className="relative z-10 bg-surface border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col"
          onClick={e => e.stopPropagation()}
          style={{ minHeight: 480 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <div className="flex items-center gap-2.5">
              <Database size={15} className="text-purple-400" />
              <div>
                <h2 className="text-sm font-semibold text-text">Capture Mode</h2>
                <p className="text-xs text-muted truncate max-w-[300px]">{project?.name}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-muted hover:text-text p-1 rounded"><X size={16} /></button>
          </div>

          {/* URL bar */}
          <div className="px-5 pt-4 pb-3 border-b border-border/50 shrink-0">
            <div className="flex gap-2">
              <input
                className="flex-1 input text-xs font-mono min-w-0"
                placeholder="https://mint.project.xyz"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadPage() }}
                disabled={isBusy}
              />
              <button
                className="btn-primary text-xs px-3 shrink-0 flex items-center gap-1.5"
                onClick={loadPage}
                disabled={isBusy || !url.trim()}
              >
                {step === 'loading' ? <Loader size={11} className="animate-spin" /> : <ExternalLink size={11} />}
                Load
              </button>
              {(step !== 'idle') && (
                <button className="btn-ghost text-xs px-2 shrink-0" onClick={reset} title="Reset">
                  <RefreshCw size={11} />
                </button>
              )}
            </div>
            <p className="text-[10px] text-muted mt-1.5">
              Open the official mint page here and click Mint to capture the execution path. You will sign normally — nothing is intercepted or modified.
            </p>
          </div>

          {/* Main area — iframe or status */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {step === 'idle' && (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8 py-8">
                <div className="w-14 h-14 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                  <Database size={24} className="text-purple-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text">Learn the execution path</p>
                  <p className="text-xs text-muted mt-1 max-w-xs">
                    Alpha Hub will watch the transaction as you mint on the official page and build a reusable profile — so Strike can fire instantly next time.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center w-full max-w-sm">
                  {[['Load', 'Open the official mint page'], ['Mint', 'Click Mint as you normally would'], ['Captured', 'Alpha Hub learns the execution path']].map(([t, d], i) => (
                    <div key={i} className="bg-surface2 rounded-lg p-2.5">
                      <div className="text-xs font-mono text-purple-300">{i + 1}. {t}</div>
                      <div className="text-[10px] text-muted mt-0.5">{d}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step === 'error' && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8 py-6">
                <AlertCircle size={28} className="text-amber-400" />
                <div>
                  <p className="text-sm font-medium text-amber-300">Mint page blocked iframe embedding</p>
                  <p className="text-xs text-muted mt-1 max-w-sm">
                    {frameError || 'This site prevents embedding. Visit it directly in your browser, then paste the transaction calldata below.'}
                  </p>
                </div>
                <ManualCaptureForm project={project} token={token.current} onSaved={p => { toast.success('Profile saved'); onSaved?.(p); onClose() }} />
              </div>
            )}

            {showIframe && (
              <div className="relative flex-1 overflow-hidden">
                <iframe
                  ref={iframeRef}
                  src={proxyUrl}
                  className="w-full h-full border-0"
                  onLoad={handleIframeLoad}
                  onError={handleIframeError}
                  title="Mint Capture"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                />
                {step === 'loading' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-surface/80 backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Loader size={14} className="animate-spin text-purple-400" />
                      Loading mint page…
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Capture success overlay — shown below iframe or standalone */}
            {(step === 'captured' || step === 'saving' || step === 'saved') && capturedTx && (
              <div className="border-t border-border/60 bg-surface shrink-0 px-5 py-3.5 space-y-3">
                <CapturedTxPanel tx={capturedTx} classified={classified} />
                {step === 'captured' && (
                  <button className="btn-primary text-xs w-full flex items-center justify-center gap-1.5" onClick={saveProfile}>
                    <Database size={11} />
                    Save Execution Profile
                  </button>
                )}
                {step === 'saving' && (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted py-1">
                    <Loader size={11} className="animate-spin" />
                    Saving profile…
                  </div>
                )}
                {step === 'saved' && (
                  <div className="flex items-center justify-center gap-2 text-xs text-green py-1">
                    <CheckCircle size={11} />
                    Profile saved — Strike pre-armed with learned execution path
                  </div>
                )}
              </div>
            )}

            {/* Capturing hint */}
            {step === 'capturing' && (
              <div className="border-t border-border/60 bg-surface2/50 shrink-0 px-5 py-2.5 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse shrink-0" />
                <p className="text-[11px] text-muted">
                  Listening for transactions. Connect your wallet on the mint page and click Mint.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CapturedTxPanel({ tx, classified }) {
  const { to, data, value, gas } = tx
  const protocolLabel = classified ? (PROTOCOL_LABELS[classified.protocol] || classified.protocol || 'Custom') : 'Custom'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-green shrink-0" />
        <span className="text-xs font-semibold text-green">Transaction captured</span>
        <span className="badge badge-green text-[10px] ml-auto">{protocolLabel}</span>
      </div>
      <div className="bg-bg/60 rounded-lg px-3 py-2 space-y-1.5">
        {[
          ['To', shortAddr(to)],
          ['Function', classified?.name || shortData(data)],
          ['Value', wei2eth(value)],
          ['Gas', gas ? Number(gas).toLocaleString() : 'TBD'],
          classified?.proofRequired && ['Proof', classified.proofShape || 'required'],
        ].filter(Boolean).map(([label, val]) => (
          <div key={label} className="flex justify-between text-xs">
            <span className="text-muted">{label}</span>
            <span className="font-mono text-text">{val}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ManualCaptureForm({ project, token, onSaved }) {
  const [calldata, setCalldata] = useState('')
  const [to, setTo] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!calldata.trim()) return
    setSaving(true)
    try {
      const { buildProfileFromCapture } = await import('../../lib/mintProfiles')
      const tx = { to: to.trim() || project?.contract_address, data: calldata.trim(), value: '0' }
      const profile = buildProfileFromCapture(tx, project)
      const t = token || (await getAuthToken())
      const res = await fetch('/api/capture/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify(profile),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
      onSaved?.(data.profile)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="w-full max-w-sm space-y-2 text-left">
      <p className="text-xs font-medium text-text">Manual capture</p>
      <input className="input text-xs w-full font-mono" placeholder="Router/contract address (0x…)" value={to} onChange={e => setTo(e.target.value)} />
      <textarea className="input text-xs w-full font-mono h-20 resize-none" placeholder="Transaction calldata (0x…)" value={calldata} onChange={e => setCalldata(e.target.value)} />
      <button
        className="btn-primary text-xs w-full flex items-center justify-center gap-1.5"
        onClick={handleSave}
        disabled={saving || !calldata.trim()}
      >
        {saving ? <Loader size={10} className="animate-spin" /> : <Database size={10} />}
        Save Profile
      </button>
    </div>
  )
}
