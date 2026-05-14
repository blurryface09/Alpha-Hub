import React, { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { useAuthStore } from '../store'
import ConnectWallet from '../components/shared/ConnectWallet'
import { Loader2, ShieldCheck, Repeat2, Sparkles, Radar, Wand2 } from 'lucide-react'

export default function AuthPage() {
  const { user, signingIn, signInWithWallet } = useAuthStore()
  const { address, chain, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState(null)

  if (user) return <Navigate to="/" replace />

  const handleSignIn = async () => {
    if (!isConnected || !address || signingIn) return
    setAttempted(true)
    setError(null)

    const result = await signInWithWallet(address, signMessageAsync, chain?.id || 1)

    if (!result.success) {
      const msg = result.error || 'Sign in failed'
      if (msg.toLowerCase().includes('rejected') || msg.toLowerCase().includes('denied')) {
        toast.error('Signature rejected — please try again')
      } else {
        toast.error(msg)
      }
      setError(msg)
      setAttempted(false)
    }
  }

  const onboarding = [
    { icon: Sparkles, title: 'Discover live Web3 opportunities before they move.', body: 'Browse mints, claims, launches, wallets, and community alpha in one friendly hub.' },
    { icon: Radar, title: 'Track what matters without reading every chart.', body: 'Save projects, follow wallets, get alerts, and keep your next actions clear.' },
    { icon: Wand2, title: 'Start simple. Go advanced when ready.', body: 'Beginner-friendly cards first. Contract details and automation stay tucked away until you need them.' },
  ]

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-5xl grid gap-6 lg:grid-cols-[1fr_390px] items-center"
      >
        <section className="hero-panel">
          <div className="hero-content">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs text-accent font-mono mb-5">
              <span className="dot-live" />
              Friendly Web3 alpha guide
            </div>
            <h1 className="text-3xl sm:text-5xl font-black leading-tight max-w-2xl">
              Find alpha, track mints, and move with more confidence.
            </h1>
            <p className="text-muted mt-4 max-w-2xl">
              Alpha Hub turns noisy wallet activity, NFT launches, and community tips into simple cards you can understand and act on.
            </p>
            <div className="grid gap-3 mt-7">
              {onboarding.map((item) => (
                <div key={item.title} className="flex gap-3 rounded-2xl border border-border bg-surface2/60 p-4">
                  <div className="h-10 w-10 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent shrink-0">
                    <item.icon size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{item.title}</div>
                    <div className="text-xs text-muted mt-1">{item.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="card space-y-5">
          <div className="text-center mb-2">
            <div className="font-mono text-xl font-bold text-accent tracking-widest mb-1">
              ALPHA/HUB
            </div>
            <p className="text-muted text-sm">Connect only when you’re ready to save and track.</p>
          </div>
          <div className="text-center space-y-1">
            <h2 className="text-base font-semibold text-text">Sign in with your wallet</h2>
            <p className="text-xs text-muted">Signing is free. It proves this wallet is yours.</p>
          </div>

          {/* Step 1 — connect wallet */}
          {!isConnected && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted">
                <div className="w-5 h-5 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center text-accent font-bold text-[10px]">1</div>
                Connect your wallet
              </div>
              <div className="flex justify-center">
                <ConnectWallet />
              </div>
            </div>
          )}

          {/* Step 2 — sign message */}
          {isConnected && !user && (
            <div className="space-y-4">
              <div className="px-3 py-2.5 rounded-lg bg-green-500/5 border border-green-500/20 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-mono text-green-400">{address.slice(0, 6)}...{address.slice(-4)}</span>
                <span className="text-xs text-muted ml-auto">connected</span>
              </div>
              <button
                onClick={() => {
                  disconnect()
                  setAttempted(false)
                  setError(null)
                  toast.success('Wallet disconnected. Choose another wallet.')
                }}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-border text-xs text-muted hover:text-accent hover:border-accent/40 transition-all"
              >
                <Repeat2 className="w-3.5 h-3.5" />
                Switch wallet
              </button>

              <div className="flex items-center gap-2 text-xs text-muted">
                <div className="w-5 h-5 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center text-accent font-bold text-[10px]">2</div>
                Sign a message to verify ownership
              </div>

              <button
                onClick={handleSignIn}
                disabled={signingIn || attempted}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-semibold text-sm text-white"
              >
                {signingIn ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for signature...</>
                ) : (
                  <><ShieldCheck className="w-4 h-4" /> Sign in to Alpha Hub</>
                )}
              </button>

              {error && (
                <button
                  onClick={() => { setAttempted(false); setError(null) }}
                  className="w-full text-xs text-accent underline text-center"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          <p className="text-xs text-muted text-center">
            Signing is free and does not send a transaction.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 justify-center lg:col-span-2">
            {['Live mints', 'Watchlists', 'Community alpha', 'AI checks'].map(f => (
              <span key={f} className="badge badge-cyan text-xs">{f}</span>
            ))}
          </div>
      </motion.div>
    </div>
  )
}
