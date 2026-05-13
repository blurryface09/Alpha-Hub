import React, { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Radar, Plus, Trash2, Eye } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'
import { useAuthStore, useWhaleStore } from '../store'
import { useSubscription } from '../hooks/useSubscription'
import { friendlyError } from '../lib/errors'
import Paywall from '../components/Paywall'
import AddWalletModal from '../components/whale/AddWalletModal'
import ActivityFeed from '../components/whale/ActivityFeed'
import { demoActivity } from '../lib/demoData'

const EXPLORER_HOSTS = {
  eth: 'etherscan.io',
  base: 'basescan.org',
  bnb: 'bscscan.com',
}

export default function WhaleRadarPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { activity, fetch: fetchActivity, subscribe } = useWhaleStore()
  const { plan, limits, hasAccess, refresh } = useSubscription()
  const [watchlist, setWatchlist] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [activeChain, setActiveChain] = useState('all')
  const [upgradeRequired, setUpgradeRequired] = useState(false)
  const [showDemoFeed, setShowDemoFeed] = useState(() => localStorage.getItem('alphahub:hideDemoWhaleFeed') !== 'true')
  const isAdmin = plan === 'admin'

  const fetchWatchlist = useCallback(async () => {
    if (!user) return
    let query = supabase
      .from('whale_watchlist')
      .select('*')
      .eq('is_active', true)
    if (!isAdmin) query = query.eq('user_id', user.id)
    const { data } = await query
    setWatchlist(data || [])
    setLoading(false)
  }, [user, isAdmin])

  useEffect(() => {
    fetchWatchlist()
    fetchActivity(isAdmin ? null : user?.id)
    if (!hasAccess('pro')) return undefined
    const unsub = subscribe(isAdmin ? null : user?.id)
    return unsub
  }, [fetchWatchlist, fetchActivity, hasAccess, subscribe, user?.id, isAdmin])

  useEffect(() => {
    const refreshOnResume = () => {
      fetchWatchlist()
      fetchActivity(isAdmin ? null : user?.id)
    }
    window.addEventListener('alphahub:resume', refreshOnResume)
    return () => {
      window.removeEventListener('alphahub:resume', refreshOnResume)
    }
  }, [fetchActivity, fetchWatchlist, user?.id, isAdmin])

  const addWallet = async ({ address, label, chain }) => {
    try {
      if (!user?.id) { toast.error('Not logged in -- please sign out and back in'); return }
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
      const insertPromise = supabase
        .from('whale_watchlist')
        .insert({ user_id: user.id, wallet_address: address, label: label || 'Unlabeled', chain, is_active: true })
        .select()
        .single()

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out after 10s')), 10000)
      )

      const { data, error } = await Promise.race([insertPromise, timeoutPromise])

      if (error) {
        console.error('Supabase whale error:', error.code, error.message)
        toast.error(friendlyError(error, 'Could not save this wallet. Please try again.'), { duration: 6000 })
        return
      }
      setWatchlist(prev => [...prev, data])
      toast.success(`Watching ${label || address.slice(0, 12)}!`)
      setShowAddModal(false)
    } catch (err) {
      console.error('Unexpected error adding wallet:', err)
      toast.error(friendlyError(err, 'Could not save this wallet. Please try again.'))
    }
  }

  const removeWallet = async (id, label) => {
    await supabase.from('whale_watchlist').delete().eq('id', id)
    setWatchlist(prev => prev.filter(w => w.id !== id))
    toast.success(`Removed ${label || 'wallet'}`)
  }

  const copyMint = async (activityItem) => {
    if (activityItem?.demo) {
      toast('Demo Copy Mint preview: real whale activity will create a MintGuard project in Confirm Mode.')
      return
    }
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

    const chain = activityItem.chain || 'eth'
    const contract = activityItem.contract_address
    const projectName = activityItem.contract_name ||
      `Whale Mint ${contract.slice(0, 6)}...${contract.slice(-4)}`

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

      const { error } = await supabase
        .from('wl_projects')
        .insert({
          user_id: user.id,
          name: projectName,
          source_url: activityItem.tx_hash ? `https://${EXPLORER_HOSTS[chain] || EXPLORER_HOSTS.eth}/tx/${activityItem.tx_hash}` : null,
          source_type: 'whale_copy',
          chain,
          contract_address: contract,
          mint_price: activityItem.value_eth ? String(activityItem.value_eth) : null,
          wl_type: 'PUBLIC',
          mint_mode: 'confirm',
          max_mint: 1,
          gas_limit: 200000,
          notes: `Copied from whale ${activityItem.wallet_label || activityItem.wallet_address || 'activity'}. Confirm mode is enabled by default.`,
          status: 'live',
        })

      if (error) throw error
      toast.success('Copied to MintGuard. Review it before minting.')
      navigate('/mintguard')
    } catch (err) {
      console.error('copy mint error:', err)
      toast.error(friendlyError(err, 'Could not copy this mint. Please try again.'))
    }
  }

  const realActivity = activeChain === 'all'
    ? activity
    : activity.filter(a => a.chain === activeChain)
  const demoFiltered = activeChain === 'all'
    ? demoActivity
    : demoActivity.filter(a => a.chain === activeChain)
  const filteredActivity = realActivity.length || !showDemoFeed || !isAdmin ? realActivity : demoFiltered

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
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Radar size={20} className="text-accent" />
            <h1 className="text-xl font-bold">WhaleRadar</h1>
            <div className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
          </div>
          <p className="text-sm text-muted">
            {hasAccess('pro') ? 'Server-monitored smart money alerts with realtime updates.' : 'Limited wallet tracking. Upgrade for realtime whale alerts.'}
            <span className="ml-2 text-xs text-accent">
              {plan === 'admin'
                ? 'Admin Mode'
                : plan === 'free' || !plan
                ? `Free limit: ${watchlist.length}/${limits.trackedWallets}`
                : `${plan?.toUpperCase()} limit: ${watchlist.length}/${limits.trackedWallets}`}
            </span>
          </p>
        </div>
        <button onClick={() => {
          if (!user) { toast.error('Not authenticated - please sign out and back in'); return }
          setShowAddModal(true)
        }} className="btn-primary flex items-center gap-2">
          <Plus size={15} />
          Watch Wallet
        </button>
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
              <div className="flex justify-center py-8"><div className="spinner" /></div>
            ) : watchlist.length === 0 ? (
              <div className="text-center py-8">
                <Eye size={28} className="text-muted mx-auto mb-2" />
                <p className="text-text text-sm font-semibold">Track smart wallets before the timeline reacts</p>
                <p className="text-xs text-muted mt-1">Add whales, deployers, or sniper wallets. Alpha Hub monitors mint activity and alerts you when something moves.</p>
                <button onClick={() => setShowAddModal(true)} className="btn-ghost mt-4 text-xs">Watch Wallet</button>
              </div>
            ) : (
              <div className="space-y-2">
                {watchlist.map(w => {
                  const recentMove = activity.find(a => a.wallet_address?.toLowerCase() === w.wallet_address?.toLowerCase())
                  return (
                    <motion.div
                      key={w.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-3 p-3 bg-surface2 rounded-lg border border-border"
                    >
                      <div className={`dot-live ${recentMove ? '' : 'opacity-30'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{w.label || 'Unlabeled'}</div>
                        <div className="font-mono text-xs text-muted truncate">
                          {w.wallet_address.slice(0, 12)}...{w.wallet_address.slice(-6)}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`badge text-[10px] ${w.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
                            {w.chain.toUpperCase()}
                          </span>
                          {recentMove && (
                            <span className="text-[10px] text-muted">
                              Last: {recentMove.method_name?.slice(0, 20)}
                            </span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => removeWallet(w.id, w.label)} className="text-muted hover:text-accent2 p-1">
                        <Trash2 size={13} />
                      </button>
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
                {!realActivity.length && showDemoFeed && isAdmin && (
                  <p className="text-[11px] text-muted mt-1">Admin demo activity shown until real wallet events arrive.</p>
                )}
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
            {!realActivity.length && isAdmin && (
              <div className="mb-3 flex flex-col gap-2 rounded-lg border border-accent/20 bg-accent/8 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-text">Copy Mint turns whale activity into MintGuard projects.</div>
                  <div className="text-xs text-muted">Demo rows are labeled and never execute automint.</div>
                </div>
                <button
                  onClick={() => {
                    const next = !showDemoFeed
                    setShowDemoFeed(next)
                    localStorage.setItem('alphahub:hideDemoWhaleFeed', next ? 'false' : 'true')
                  }}
                  className="btn-ghost text-xs whitespace-nowrap"
                >
                  {showDemoFeed ? 'Hide demo activity' : 'View Demo Feed'}
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
