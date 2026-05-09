import React, { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAccount } from 'wagmi'
import { useAuthStore } from '../store'
import ConnectWallet from '../components/shared/ConnectWallet'
import { Zap, Shield, Clock, Loader2 } from 'lucide-react'

const FEATURES = [
  { icon: Shield, text: 'MintGuard' },
  { icon: Zap, text: 'WhaleRadar' },
  { icon: Clock, text: 'Wallet Forensics' },
]

export default function AuthPage() {
  const { user, loading, signInWithWallet } = useAuthStore()
  const { address, isConnected } = useAccount()

  // Auto sign in when wallet connects
  useEffect(() => {
    if (isConnected && address && !user && !loading) {
      signInWithWallet(address).then((result) => {
        if (!result.success) {
          toast.error('Sign in failed: ' + (result.error || 'Unknown error'))
        }
      })
    }
  }, [isConnected, address, user, loading])

  if (user) return <Navigate to="/" replace />

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="font-mono text-xl font-bold text-accent tracking-widest mb-1">
            ALPHA/HUB
          </div>
          <p className="text-muted text-sm">On-chain intelligence platform</p>
        </div>

        <div className="card">
          <div className="text-center space-y-2 mb-6">
            <h2 className="text-base font-semibold text-text">Connect your wallet</h2>
            <p className="text-xs text-muted">
              No email. No password. Your wallet is your identity.
            </p>
          </div>

          {/* Connect button */}
          <div className="flex justify-center mb-4">
            <ConnectWallet />
          </div>

          {/* Loading state after wallet connects */}
          {isConnected && !user && (
            <div className="flex items-center justify-center gap-2 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              <span className="text-xs text-muted font-mono">Signing you in...</span>
            </div>
          )}

          {/* Connected address */}
          {isConnected && address && (
            <div className="mt-2 px-3 py-2 rounded-lg bg-green-500/5 border border-green-500/20 text-center">
              <p className="text-xs font-mono text-green-400">
                {address.slice(0, 6)}...{address.slice(-4)}
              </p>
            </div>
          )}

          <p className="text-xs text-muted text-center mt-4">
            Your keys, your data. Nothing stored without your consent.
          </p>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap gap-2 justify-center mt-6">
          {['MintGuard', 'WhaleRadar', 'Rug Detector', 'Wallet Forensics'].map(f => (
            <span key={f} className="badge badge-cyan text-xs">{f}</span>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
