import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { Radar, Plus, Trash2, Eye, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'
import { useAuthStore, useWhaleStore, useWalletIntelStore } from '../store'
import { useSubscription } from '../hooks/useSubscription'
import { friendlyError } from '../lib/errors'
import Paywall from '../components/Paywall'
import AddWalletModal from '../components/whale/AddWalletModal'
import ActivityFeed from '../components/whale/ActivityFeed'
import WalletIntelPanel from '../components/whale/WalletIntelPanel'
import FollowWalletButton from '../components/whale/FollowWalletButton'

const EXPLORER_HOSTS = {
  eth: 'etherscan.io',
  base: 'basescan.org',
  bnb: 'bscscan.com',
}

export default function WhaleRadarPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { address, isConnected } = useAccount()
  const { activity, fetch: fetchActivity, subscribe } = useWhaleStore()
  const { watchedWallets, loading, followWallet, unfollowWallet, fetchWatched } = useWalletIntelStore()
  const { plan, limits, hasAccess, refresh } = useSubscription()
  const [showAddModal, setShowAddModal] = useState(false)
  const [activeChain, setActiveChain] = useState('all')
  const [upgradeRequired, setUpgradeRequired] = useState(false)
  const [expandedWallet, setExpandedWallet] = useState(null)
  const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()
  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET

  // Admin needs full watchlist; regular users already loaded via DashboardLayout
  useEffect(() => {
    if (isAdmin && user) fetchWatched(null)
  }, [isAdmin, user, fetchWatched])

  useEffect(() => {
    fetchActivity(isAdmin ? null : user?.id)
    if (!hasAccess('pro')) return undefined
    const unsub = subscribe(isAdmin ? null : user?.id)
    return unsub
  }, [fetchActivity, hasAccess, subscribe, user?.id, isAdmin])

  useEffect(() => {
    const refreshOnResume = () => fetchActivity(isAdmin ? null : user?.id)
    window.addEventListener('alphahub:resume', refreshOnResume)
    return () => window.removeEventListener('alphahub:resume', refreshOnResume)
  }, [fetchActivity, user?.id, isAdmin])

  // watchlist shown on this page
  const watchlist = isAdmin
    ? watchedWallets
    : watchedWallets.filter(() => true) // already scoped to user by store

  const addWallet = async ({ address, label, chain }) => {
    try {
      if (!user?.id) { toast.error('Not logged in — please sign out and back in'); return }
      if (!address || !address.startsWith('0x')) { toast.error('Invalid wallet address'); return }
      if (watchlist.find(w => w.wallet_address.toLowerCase() === address.toLowerCase() && w.chain === chain)) {
        toast.error('Already watching this wallet')
        return
      }
      if (watchlist.length >= limits.trackedWallets) {
        setUpgradeRequired(true)
        toast.error(`Your ${plan || 'Free'} plan tracks ${limits.trackedWallets} wallet${limits.trackedWallets === 1 ? '' : 's'}. Upgrade to add more.`)
        return
      }
      const { error } = await followWallet(user.id, address, label, chain)
      if (error) {
        toast.error(friendlyError(error, 'Could not save this wallet. Please try again.'), { duration: 6000 })
        return
      }
      toast.success(`Watching ${label || address.slice(0, 12)}!`)
      setShowAddModal(false)
    } catch (err) {
      toast.error(friendlyError(err, 'Could not save this wallet. Please try again.'))
    }
  }

  const removeWallet = async (id, label) => {
    await unfollowWallet(user.id, id)
    toast.success(`Removed ${label || 'wallet'}`)
  }

  const copyMint = async (activityItem) => {
    if (!hasAccess('pro')) {
      setUpgradeRequired(true)
      toast.error('Copy minting requires Pro.')
      return
    }
    if (!user?.id) {
      toast.error('Sign in again before copying this mint.')
      return
    }
    if (!activityItem?.contract_address) {
      toast.error('This whale mint does not include a contract address.')
      return
    }

    try {
      const { count } = await supabase
        .from('wl_projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)

      if ((count || 0) >= limits.mintProjects) {
        setUpgradeRequired(true)
        toast.error(`Your ${plan || 'current'} plan tracks ${limits.mintProjects} mint projects. Upgrade to copy more.`)
        return
      }

      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before copying this mint.')
      const res = await fetch('/api/calendar/copy-mint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ activity: activityItem }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not copy this mint.')
      toast.success(data.duplicate ? 'Already in MintGuard.' : 'Copied to MintGuard. Review it before minting.')
      navigate('/mintguard')
    } catch (err) {
      console.error('copy mint error:', err)
      toast.error(friendlyError(err, 'Could not copy this mint. Please try again.'))
    }
  }

  const realActivity = activeChain === 'all'
    ? activity
    : activity.filter(a => a.chain === activeChain)
  const filteredActivity = realActivity

  const mintActivity = activity.filter(a => a.is_mint)
  const largeMovers = activity.filter(a => parseFloat(a.value_eth) > 1)

  if (upgradeRequired) {
    return (
      <Paywall
        onSuccess={refresh}
        showBack
        requiredPlan="pro"
        currentPlan={plan || 'free'}
        lockMessage="More tracked wallets require Pro."
      />
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="hero-panel mb-6">
        <div className="hero-content flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="mascot-orb"><Radar size={17} /></span>
              <span className="badge badge-green">Live watchlist</span>
              <span className="badge badge-cyan">Copy Mint</span>
            </div>
            <h1 className="text-3xl font-black tracking-tight">Follow wallets that move first.</h1>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              Track smart wallets, deployers, and mint hunters. When a watched wallet mints, Alpha Hub can turn that signal into a personal MintGuard project.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="filter-chip active">{watchlist.length} watching</span>
              <span className="filter-chip">{mintActivity.length} mint signals</span>
              <span className="filter-chip">
                {plan === 'admin'
                  ? 'Admin Mode'
                  : plan === 'free' || !plan
                  ? `${watchlist.length}/${limits.trackedWallets} free slots`
                  : `${watchlist.length}/${limits.trackedWallets} ${plan?.toUpperCase()} slots`}
              </span>
            </div>
          </div>
          <button onClick={() => {
            if (!user) { toast.error('Please sign out and back in, then try again.'); return }
            setShowAddModal(true)
          }} className="btn-primary flex items-center justify-center gap-2">
            <Plus size={15} />
            Track Wallet
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Stats */}
        <div className="metric-card">
          <div className="text-2xl font-bold text-accent">{watchlist.length}</div>
          <div className="section-label mt-1 mb-0">Wallets Watching</div>
        </div>
        <div className="metric-card">
          <div className="text-2xl font-bold text-green">{mintActivity.length}</div>
          <div className="section-label mt-1 mb-0">Mints Detected</div>
        </div>
        <div className="metric-card">
          <div className="text-2xl font-bold text-accent3">{largeMovers.length}</div>
          <div className="section-label mt-1 mb-0">Large Moves (&gt;1 ETH)</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Watchlist */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="section-label">Watchlist ({watchlist.length})</div>
            {loading ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="alpha-loader scale-75" />
                <p className="mt-2 text-xs text-muted">Loading watched wallets...</p>
              </div>
            ) : watchlist.length === 0 ? (
              <div className="text-center py-8">
                <Sparkles size={28} className="text-accent mx-auto mb-2" />
                <p className="text-text text-sm font-semibold">Track smart wallets before the timeline reacts</p>
                <p className="text-xs text-muted mt-1">Add whales, deployers, or sniper wallets. Alpha Hub monitors mint activity and alerts you when something moves.</p>
                <button onClick={() => setShowAddModal(true)} className="btn-ghost mt-4 text-xs">Track a wallet</button>
              </div>
            ) : (
              <div className="space-y-2">
                {watchlist.map(w => {
                  const recentMove = activity.find(a => a.wallet_address?.toLowerCase() === w.wallet_address?.toLowerCase())
                  const isExpanded = expandedWallet === w.id
                  return (
                    <motion.div
                      key={w.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="bg-surface2 rounded-lg border border-border overflow-hidden"
                    >
                      <div className="flex items-center gap-2 p-3">
                        <div className={`dot-live flex-shrink-0 ${recentMove ? '' : 'opacity-30'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold truncate">{w.label || 'Unlabeled'}</div>
                          <div className="font-mono text-xs text-muted truncate">
                            {w.wallet_address.slice(0, 10)}…{w.wallet_address.slice(-6)}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className={`badge text-[10px] ${w.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
                              {w.chain.toUpperCase()}
                            </span>
                            {recentMove && (
                              <span className="text-[10px] text-muted">
                                {recentMove.method_name?.slice(0, 18)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <FollowWalletButton
                            address={w.wallet_address}
                            chain={w.chain}
                            label={w.label}
                          />
                          <button
                            onClick={() => setExpandedWallet(isExpanded ? null : w.id)}
                            title="Wallet Intelligence"
                            className={`p-1.5 rounded-md border transition-all
                              ${isExpanded
                                ? 'border-accent/40 text-accent bg-accent/8'
                                : 'border-border2 text-muted hover:border-accent hover:text-accent'}`}
                          >
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>
                          <button
                            onClick={() => removeWallet(w.id, w.label)}
                            className="p-1.5 rounded-md border border-border2 text-muted hover:border-red-500/40 hover:text-red-400 transition-all"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="border-t border-border px-3 py-3"
                          >
                            <WalletIntelPanel
                              address={w.wallet_address}
                              chain={w.chain}
                              label={w.label}
                              recentActivity={activity}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Activity Feed */}
        <div className="lg:col-span-3">
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="section-label mb-0">Live Activity Feed</div>
              </div>
              <div className="flex gap-1">
                {['all', 'eth', 'base', 'bnb'].map(c => (
                  <button
                    key={c}
                    onClick={() => setActiveChain(c)}
                    className={`text-xs px-2.5 py-1 rounded-md font-mono transition-all ${
                      activeChain === c ? 'bg-accent/15 text-accent border border-accent/20' : 'text-muted hover:text-text'
                    }`}
                  >
                    {c.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {!realActivity.length && (
              <div className="mb-3 flex flex-col gap-2 rounded-lg border border-accent/20 bg-accent/8 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-text">Copy Mint turns wallet movement into a tracked launch.</div>
                  <div className="text-xs text-muted">Real whale mint activity will appear here once tracked wallets move.</div>
                </div>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="btn-ghost text-xs whitespace-nowrap"
                >
                  Watch Wallet
                </button>
              </div>
            )}
            <ActivityFeed activity={filteredActivity} onCopyMint={copyMint} />
          </div>
        </div>
      </div>

      {showAddModal && (
        <AddWalletModal onAdd={addWallet} onClose={() => setShowAddModal(false)} />
      )}
    </div>
  )
}
