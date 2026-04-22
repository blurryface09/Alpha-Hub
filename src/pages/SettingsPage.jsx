import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Settings, Key, Wallet, Save, Eye, EyeOff, Check, ExternalLink } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuthStore, useSettingsStore } from '../store'
import { supabase } from '../lib/supabase'

export default function SettingsPage() {
  const { user, profile, fetchProfile } = useAuthStore()
  const { etherscanKey, groqKey, alchemyKey, walletConnectId, setKeys } = useSettingsStore()

  const [form, setForm] = useState({
    etherscanKey: etherscanKey || '',
    groqKey: groqKey || '',
    alchemyKey: alchemyKey || '',
    walletConnectId: walletConnectId || '',
  })
  const [username, setUsername] = useState(profile?.username || '')
  const [walletAddress, setWalletAddress] = useState(profile?.wallet_address || '')

  // Sync form when profile loads/updates from Supabase
  useEffect(() => {
    if (profile?.username) setUsername(profile.username)
    if (profile?.wallet_address) setWalletAddress(profile.wallet_address)
  }, [profile])
  const [show, setShow] = useState({})
  const [saving, setSaving] = useState(false)

  const toggleShow = (key) => setShow(s => ({ ...s, [key]: !s[key] }))

  const saveKeys = () => {
    setKeys(form)
    toast.success('API keys saved')
  }

  const saveProfile = async () => {
    setSaving(true)
    try {
      const { error } = await supabase.from('profiles').upsert({
        id: user.id,
        username,
        wallet_address: walletAddress,
        updated_at: new Date().toISOString(),
      })
      if (error) throw error
      await fetchProfile(user.id)
      toast.success('Profile updated')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const API_KEYS = [
    {
      key: 'etherscanKey',
      label: 'Etherscan API Key',
      desc: 'Powers wallet lookup and contract scanning on ETH + Base',
      link: 'https://etherscan.io/apis',
      linkLabel: 'Get free key',
      placeholder: 'Your Etherscan V2 API key',
    },
    {
      key: 'groqKey',
      label: 'Groq API Key',
      desc: 'Powers all AI forensic analysis — completely free tier available',
      link: 'https://console.groq.com',
      linkLabel: 'Get free key',
      placeholder: 'gsk_...',
    },
    {
      key: 'alchemyKey',
      label: 'Alchemy API Key',
      desc: 'Powers real-time blockchain data for ETH and Base chains',
      link: 'https://alchemy.com',
      linkLabel: 'Get free key',
      placeholder: 'Your Alchemy API key',
    },
    {
      key: 'walletConnectId',
      label: 'WalletConnect Project ID',
      desc: 'Required for connecting MetaMask and executing mint transactions',
      link: 'https://cloud.walletconnect.com',
      linkLabel: 'Get free ID',
      placeholder: 'Your WalletConnect project ID',
    },
  ]

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <Settings size={20} className="text-accent" />
        <h1 className="text-xl font-bold">Settings</h1>
      </div>
      <p className="text-sm text-muted mb-6">API keys and profile configuration.</p>

      {/* Profile */}
      <div className="card mb-4">
        <div className="section-label">Profile</div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">Username</label>
            <input
              className="input"
              placeholder="your_username"
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">
              Wallet Address (for mint execution)
            </label>
            <input
              className="input font-mono"
              placeholder="0x... your wallet address"
              value={walletAddress}
              onChange={e => setWalletAddress(e.target.value)}
            />
            <p className="text-xs text-muted mt-1.5">
              This is used to track your wallet. Connect via MetaMask for actual transaction signing.
            </p>
          </div>
          <button
            onClick={saveProfile}
            disabled={saving}
            className="btn-primary flex items-center gap-2"
          >
            {saving ? <div className="spinner w-3.5 h-3.5" /> : <Save size={14} />}
            Save Profile
          </button>
        </div>
      </div>

      {/* API Keys */}
      <div className="card mb-4">
        <div className="section-label">API Keys</div>
        <div className="bg-surface2 border border-border rounded-lg px-3 py-2.5 mb-4 text-xs text-muted flex items-start gap-2">
          <Key size={12} className="text-accent mt-0.5 flex-shrink-0" />
          Keys are stored locally in your browser only. Never sent to any server except their respective APIs.
        </div>
        <div className="space-y-4">
          {API_KEYS.map(k => (
            <div key={k.key}>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-mono text-muted uppercase tracking-wider">{k.label}</label>
                <a
                  href={k.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline flex items-center gap-1"
                >
                  {k.linkLabel} <ExternalLink size={10} />
                </a>
              </div>
              <div className="relative">
                <input
                  className="input pr-10 font-mono text-xs"
                  type={show[k.key] ? 'text' : 'password'}
                  placeholder={k.placeholder}
                  value={form[k.key]}
                  onChange={e => setForm(f => ({ ...f, [k.key]: e.target.value }))}
                />
                <button
                  onClick={() => toggleShow(k.key)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                >
                  {show[k.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <p className="text-xs text-muted mt-1">{k.desc}</p>
              {form[k.key] && (
                <div className="flex items-center gap-1 mt-1">
                  <Check size={11} className="text-green" />
                  <span className="text-xs text-green">Key set</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <button onClick={saveKeys} className="btn-primary flex items-center gap-2 mt-4">
          <Save size={14} />
          Save All Keys
        </button>
      </div>

      {/* Account info */}
      <div className="card">
        <div className="section-label">Account</div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between py-2 border-b border-border">
            <span className="text-muted">Email</span>
            <span className="font-mono text-xs">{user?.email}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border">
            <span className="text-muted">User ID</span>
            <span className="font-mono text-xs">{user?.id?.slice(0, 16)}...</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-muted">Member since</span>
            <span className="text-xs">{user?.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
