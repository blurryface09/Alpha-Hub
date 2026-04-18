import React, { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../store'

export default function AuthPage() {
  const { user } = useAuthStore()
  const [mode, setMode] = useState('signin') // signin | signup
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)

  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        if (data.user) {
          await supabase.from('profiles').insert({ id: data.user.id, username })
          toast.success('Account created! Welcome to Alpha Hub.')
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        toast.success('Welcome back.')
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

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
          {/* Mode toggle */}
          <div className="flex bg-surface2 rounded-lg p-1 mb-6">
            {['signin', 'signup'].map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                  mode === m ? 'bg-surface text-accent border border-border2' : 'text-muted'
                }`}
              >
                {m === 'signin' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Username</label>
                <input
                  className="input"
                  placeholder="your_username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  required
                />
              </div>
            )}
            <div>
              <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Email</label>
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Password</label>
              <input
                className="input"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full mt-2 flex items-center justify-center gap-2"
            >
              {loading && <div className="spinner w-3.5 h-3.5" />}
              {mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

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
