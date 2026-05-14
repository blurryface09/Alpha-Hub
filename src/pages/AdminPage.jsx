import React, { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { getAuthToken } from '../lib/supabase'
import { PAYMENT_CONFIG } from '../config/payments'
import toast from 'react-hot-toast'
import {
  Shield, Users, Plus, Trash2, RefreshCw,
  Wallet, Clock, CheckCircle2, XCircle, Loader2,
  TrendingUp, Calendar, Copy, CreditCard, Database, Radio, Send, Server, ExternalLink
} from 'lucide-react'

const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()

const PLAN_DAYS = {
  free: 30,
  pro: 30,
  elite: 30,
}

const PLAN_COLORS = {
  free: 'text-slate-300 bg-slate-500/10 border-slate-500/20',
  weekly: 'text-slate-300 bg-slate-500/10 border-slate-500/20',
  pro: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  monthly: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  elite: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  quarterly: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  founder: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
}

function StatCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className="card p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={16} />
      </div>
      <div>
        <div className="text-xl font-bold text-text">{value}</div>
        <div className="text-xs text-muted">{label}</div>
        {sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

export default function AdminPage() {
  const { address, isConnected } = useAccount()
  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET

  const [subscribers, setSubscribers] = useState([])
  const [pendingPayments, setPendingPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [systemStatus, setSystemStatus] = useState(null)
  const [adding, setAdding] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)

  const [newWallet, setNewWallet] = useState('')
  const [newPlan, setNewPlan] = useState('pro')
  const [newNote, setNewNote] = useState('')

  const fetchSubscribers = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again to manage subscribers')
      const res = await fetch('/api/admin-subscriptions', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load subscribers')
      setSubscribers(data.subscriptions || [])
      setPendingPayments(data.pendingPayments || [])
    } catch (err) {
      toast.error(err.message || 'Failed to load subscribers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    fetchSubscribers()
    fetch('/api/status')
      .then(res => res.json())
      .then(setSystemStatus)
      .catch(() => setSystemStatus({ status: 'unreachable', checks: {} }))
  }, [isAdmin, fetchSubscribers])

  const activeSubscribers = subscribers.filter(s => s.status === 'active' && s.verified && new Date(s.expires_at) > new Date())
  const totalEth = subscribers.reduce((sum, s) => sum + parseFloat(s.amount_eth || 0), 0)

  const handleAddSubscriber = async () => {
    const normalizedWallet = newWallet.trim()
    if (!normalizedWallet || !normalizedWallet.startsWith('0x') || normalizedWallet.length !== 42) {
      toast.error('Enter a valid wallet address')
      return
    }

    setAdding(true)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again to grant access')
      const res = await fetch('/api/admin-subscriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          walletAddress: normalizedWallet,
          plan: newPlan,
          reason: 'manual_admin_grant',
        }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to add subscriber')

      toast.success('Access granted to ' + normalizedWallet.slice(0, 6) + '...' + normalizedWallet.slice(-4))
      setNewWallet('')
      setNewNote('')
      setShowAddForm(false)
      fetchSubscribers()
    } catch (err) {
      toast.error(err.message || 'Failed to grant access. Please try again.')
    } finally {
      setAdding(false)
    }
  }

  const handlePaymentDecision = async (payment, action) => {
    const label = action === 'approve' ? 'approve' : 'reject'
    if (!confirm(`${label[0].toUpperCase() + label.slice(1)} payment ${payment.tx_hash.slice(0, 10)}...?`)) return

    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again to review payments')
      const endpoint = action === 'approve' ? '/api/admin/payments/approve' : '/api/admin/payments/reject'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ paymentId: payment.id }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || `Failed to ${label} payment`)
      toast.success(action === 'approve' ? 'Subscription activated' : 'Payment rejected')
      fetchSubscribers()
    } catch (err) {
      toast.error(err.message || `Failed to ${label} payment`)
    }
  }

  const handleRevoke = async (id, wallet) => {
    if (!confirm('Revoke access for ' + wallet.slice(0, 6) + '...' + wallet.slice(-4) + '?')) return

    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again to revoke access')
      const res = await fetch('/api/admin-subscriptions?id=' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to revoke access')
      toast.success('Access revoked')
      fetchSubscribers()
    } catch (err) {
      toast.error('Failed to revoke access')
    }
  }

  const handleExtend = async (id, currentExpiry, plan) => {
    try {
      const base = new Date(currentExpiry) > new Date() ? new Date(currentExpiry) : new Date()
      const days = PLAN_DAYS[plan] || 30
      const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000)

      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again to extend access')
      const res = await fetch('/api/admin-subscriptions', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id, expiresAt: newExpiry.toISOString() }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to extend')
      toast.success('Extended by ' + days + ' days')
      fetchSubscribers()
    } catch (err) {
      toast.error('Failed to extend')
    }
  }

  const copyAddress = (addr) => {
    navigator.clipboard.writeText(addr)
    toast.success('Copied!')
  }

  const daysRemaining = (expiresAt) => {
    const diff = new Date(expiresAt) - new Date()
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
  }

  const isActive = (s) => s.status === 'active' && s.verified && new Date(s.expires_at) > new Date()

  const health = systemStatus?.checks || {}
  const healthItems = [
    { label: 'API', value: systemStatus?.status || 'checking', ok: health.api?.ok !== false, icon: Server },
    { label: 'Payments', value: health.payment?.status || 'checking', ok: health.payment?.ok !== false, icon: CreditCard },
    { label: 'RPC', value: health.rpc?.status || 'checking', ok: health.rpc?.ok !== false, icon: Radio },
    { label: 'Telegram', value: health.telegram?.ok ? 'healthy' : 'down', ok: health.telegram?.ok !== false, icon: Send },
    { label: 'Supabase', value: health.supabase?.latencyMs != null ? `${health.supabase.latencyMs}ms` : 'checking', ok: health.supabase?.ok !== false, icon: Database },
    { label: 'Cron', value: health.cron?.ok ? 'protected' : 'missing secret', ok: health.cron?.ok !== false, icon: Clock },
    { label: 'Automint', value: health.automint?.status || 'safe_mode', ok: health.automint?.ok !== false, icon: Shield },
    { label: 'Queue/Redis', value: health.redis?.status || 'optional', ok: true, icon: Radio },
  ]

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <Shield size={40} className="text-muted" />
        <p className="text-muted text-sm">Admin access only</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text flex items-center gap-2">
            <Shield size={20} className="text-accent" />
            Admin Panel
          </h1>
          <p className="text-xs text-muted mt-0.5">Manage subscribers and access</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchSubscribers}
            className="p-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition-all"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent/90 transition-all"
          >
            <Plus size={14} />
            Add User
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Users}
          label="Active Users"
          value={activeSubscribers.length}
          sub={subscribers.length + ' total'}
          color="bg-violet-500/10 text-violet-400"
        />
        <StatCard
          icon={TrendingUp}
          label="ETH Collected"
          value={totalEth.toFixed(4)}
          sub="all time"
          color="bg-cyan-500/10 text-cyan-400"
        />
        <StatCard
          icon={CheckCircle2}
          label="Verified"
          value={subscribers.filter(s => s.verified).length}
          sub={`${pendingPayments.length} pending`}
          color="bg-green-500/10 text-green-400"
        />
        <StatCard
          icon={Clock}
          label="Expiring Soon"
          value={activeSubscribers.filter(s => daysRemaining(s.expires_at) <= 3).length}
          sub="within 3 days"
          color="bg-amber-500/10 text-amber-400"
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="section-label mb-1">System Health</div>
            <h2 className="text-sm font-semibold">Admin operational status</h2>
          </div>
          <button
            onClick={() => fetch('/api/status').then(res => res.json()).then(setSystemStatus)}
            className="p-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition-all"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {healthItems.map(item => (
            <div key={item.label} className="metric-card flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${item.ok ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'}`}>
                <item.icon size={14} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium">{item.label}</div>
                <div className="text-xs text-muted truncate">{item.value}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="card p-5 border border-accent/20 space-y-4">
          <h3 className="text-sm font-semibold text-text flex items-center gap-2">
            <Plus size={14} className="text-accent" />
            Grant Access
          </h3>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">
                Wallet Address
              </label>
              <input
                className="input w-full min-w-0 font-mono text-xs sm:text-sm"
                placeholder="0x..."
                value={newWallet}
                onChange={e => setNewWallet(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div>
              <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">
                Plan
              </label>
              <div className="grid grid-cols-3 gap-2">
                {Object.keys(PLAN_DAYS).map(plan => (
                  <button
                    key={plan}
                    onClick={() => setNewPlan(plan)}
                    className={`py-2 px-3 rounded-lg border text-xs font-medium capitalize transition-all ${
                      newPlan === plan
                        ? PLAN_COLORS[plan]
                        : 'border-border text-muted hover:border-accent/30'
                    }`}
                  >
                    {plan}
                    <div className="text-[10px] opacity-60">{PLAN_DAYS[plan]}d</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => handleAddSubscriber()}
                disabled={adding}
                className="flex-1 flex items-center justify-center gap-2 py-3 sm:py-2.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90 disabled:opacity-50 transition-all"
              >
                {adding ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {adding ? 'Granting...' : 'Grant Access'}
              </button>
              <button
                onClick={() => { setShowAddForm(false); setNewWallet('') }}
                className="px-4 py-3 sm:py-2.5 rounded-lg border border-border text-muted text-sm hover:text-text transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text">Pending Payments</h3>
            <p className="text-xs text-muted mt-0.5">Manual review queue for Base ETH payments</p>
          </div>
          <span className="text-xs text-muted">{pendingPayments.length} pending</span>
        </div>

        {pendingPayments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <CreditCard size={28} className="text-muted" />
            <p className="text-sm text-muted">No pending payments</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {pendingPayments.map(payment => (
              <div key={payment.id} className="px-5 py-4 grid grid-cols-1 xl:grid-cols-[1.3fr_.8fr_.8fr_.9fr_1fr_auto] gap-3 items-center hover:bg-surface2/50 transition-all">
                <div>
                  <div className="text-xs font-mono text-text">
                    {payment.wallet_address.slice(0, 8)}...{payment.wallet_address.slice(-6)}
                  </div>
                  <div className="text-[10px] text-muted mt-1">
                    {new Date(payment.created_at).toLocaleString()}
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-1 rounded-full border capitalize w-fit ${PLAN_COLORS[payment.plan] || PLAN_COLORS.pro}`}>
                  {payment.plan}
                </span>
                <span className="text-xs text-muted capitalize">{payment.billing_cycle}</span>
                <span className="text-xs text-text">{payment.amount_eth} ETH</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">${payment.amount_usd}</span>
                  <a
                    href={`${PAYMENT_CONFIG.explorerBaseUrl}/${payment.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-400 hover:text-cyan-300"
                    title="View transaction"
                  >
                    <ExternalLink size={13} />
                  </a>
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <button
                    onClick={() => handlePaymentDecision(payment, 'approve')}
                    className="px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-300 text-xs font-semibold hover:bg-green-500/15"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handlePaymentDecision(payment, 'reject')}
                    className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs font-semibold hover:bg-red-500/15"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Subscribers list */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">All Subscribers</h3>
          <span className="text-xs text-muted">{subscribers.length} total</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        ) : subscribers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <Users size={28} className="text-muted" />
            <p className="text-sm text-muted">No subscribers yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {subscribers.map(sub => (
              <div key={sub.id} className="px-5 py-4 flex items-start gap-3 hover:bg-surface2/50 transition-all">

                {/* Status dot */}
                <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${isActive(sub) ? 'bg-green-400' : 'bg-red-400/50'}`} />

                <div className="flex-1 min-w-0 space-y-1">
                  {/* Wallet */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-text">
                      {sub.wallet_address.slice(0, 8)}...{sub.wallet_address.slice(-6)}
                    </span>
                    <button onClick={() => copyAddress(sub.wallet_address)} className="text-muted hover:text-accent transition-colors">
                      <Copy size={10} />
                    </button>
                    {sub.tx_hash?.startsWith('manual') && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        manual
                      </span>
                    )}
                  </div>

                  {/* Plan + expiry */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${PLAN_COLORS[sub.plan]}`}>
                      {sub.plan}
                    </span>
                    {isActive(sub) ? (
                      <span className="text-[10px] text-green-400">
                        {daysRemaining(sub.expires_at)}d remaining
                      </span>
                    ) : sub.status === 'pending_verification' ? (
                      <span className="text-[10px] text-amber-400">Pending review</span>
                    ) : (
                      <span className="text-[10px] text-red-400">Expired</span>
                    )}
                    <span className="text-[10px] text-muted">
                      {sub.amount_eth > 0 ? sub.amount_eth + ' ETH' : 'free'}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleExtend(sub.id, sub.expires_at, sub.plan)}
                    title="Extend by plan duration"
                    className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-all"
                  >
                    <Calendar size={13} />
                  </button>
                  <button
                    onClick={() => handleRevoke(sub.id, sub.wallet_address)}
                    title="Revoke access"
                    className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
