import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Radar, Plus, Trash2, RefreshCw, Eye, TrendingUp, Activity } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'
import { useAuthStore, useWhaleStore } from '../store'
import { getLatestActivity, decodeMethodName, CHAINS } from '../lib/blockchain'
import { summarizeWhaleMove } from '../lib/ai'
import AddWalletModal from '../components/whale/AddWalletModal'
import ActivityFeed from '../components/whale/ActivityFeed'

const POLL_INTERVAL = 30000 // 30 seconds

export default function WhaleRadarPage() {
  const { user } = useAuthStore()
  const { activity, fetch: fetchActivity, subscribe } = useWhaleStore()
  const [watchlist, setWatchlist] = useState([])
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [activeChain, setActiveChain] = useState('all')
  const pollRef = useRef(null)

  const fetchWatchlist = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('whale_watchlist')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
    setWatchlist(data || [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    fetchWatchlist()
    fetchActivity()
    const unsub = subscribe()
    return unsub
  }, [])

  // Polling engine
  useEffect(() => {
    if (!watchlist.length) return
    const poll = async () => {
      setPolling(true)
      for (const whale of watchlist) {
        try {
          const chainKey = whale.chain || 'eth'
          const newTxs = await getLatestActivity(whale.wallet_address, chainKey, whale.last_tx_hash)
          if (!newTxs.length) continue

          for (const tx of newTxs) {
            const methodName = decodeMethodName(tx.methodId)
            const isMint = tx.isMint

            // Get AI summary
            let aiSummary = null
            try {
              aiSummary = await summarizeWhaleMove({
                label: whale.label,
                address: whale.wallet_address,
                chain: chainKey,
                txHash: tx.hash,
                value: tx.value,
                methodName,
                contractAddress: tx.to,
                isMint,
              })
            } catch {}

            // Store in whale_activity
            await supabase.from('whale_activity').upsert({
              wallet_address: whale.wallet_address,
              wallet_label: whale.label,
              chain: chainKey,
              tx_hash: tx.hash,
              action_type: methodName,
              contract_address: tx.to,
              value_eth: parseFloat(tx.value),
              method_id: tx.methodId,
              method_name: methodName,
              is_mint: isMint,
              timestamp: tx.timestamp.toISOString(),
              raw_data: { ...tx, ai_summary: aiSummary },
            }, { onConflict: 'tx_hash' })

            // Notify user
            await supabase.from('notifications').insert({
              user_id: user.id,
              type: isMint ? 'whale_mint' : 'whale_move',
              title: `${isMint ? '🟢 WHALE MINTING' : '🐋 Whale Move'} — ${whale.label || whale.wallet_address.slice(0, 10)}...`,
              message: `${methodName} · ${tx.value} ${CHAINS[chainKey]?.symbol || 'ETH'} · ${CHAINS[chainKey]?.name}${aiSummary ? '\n' + aiSummary : ''}`,
              data: { tx_hash: tx.hash, wallet: whale.wallet_address, chain: chainKey },
            })
          }

          // Update last tx hash
          await supabase.from('whale_watchlist')
            .update({ last_tx_hash: newTxs[0].hash, last_checked: new Date().toISOString() })
            .eq('id', whale.id)

        } catch (err) {
          console.error(`Failed polling ${whale.label || whale.wallet_address}:`, err)
        }
      }
      setPolling(false)
    }

    poll() // immediate
    pollRef.current = setInterval(poll, POLL_INTERVAL)
    return () => clearInterval(pollRef.current)
  }, [watchlist, user])

  const addWallet = async ({ address, label, chain }) => {
    if (watchlist.find(w => w.wallet_address.toLowerCase() === address.toLowerCase() && w.chain === chain)) {
      toast.error('Already watching this wallet')
      return
    }
    const { data, error } = await supabase.from('whale_watchlist')
      .insert({ user_id: user.id, wallet_address: address, label, chain })
      .select().single()
    if (error) { toast.error('Failed to add wallet'); return }
    setWatchlist(prev => [...prev, data])
    toast.success(`Now watching ${label || address.slice(0, 12)}...`)
    setShowAddModal(false)
  }

  const removeWallet = async (id, label) => {
    await supabase.from('whale_watchlist').delete().eq('id', id)
    setWatchlist(prev => prev.filter(w => w.id !== id))
    toast.success(`Removed ${label || 'wallet'}`)
  }

  const filteredActivity = activeChain === 'all'
    ? activity
    : activity.filter(a => a.chain === activeChain)

  const mintActivity = activity.filter(a => a.is_mint)
  const largeMovers = activity.filter(a => parseFloat(a.value_eth) > 1)

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Radar size={20} className="text-accent" />
            <h1 className="text-xl font-bold">WhaleRadar</h1>
            {polling && <div className="spinner w-3 h-3" />}
          </div>
          <p className="text-sm text-muted">
            Track smart money. Know what they're minting before everyone else.
          </p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center gap-2">
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
                <p className="text-muted text-sm">No wallets being tracked</p>
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
              <div className="section-label mb-0">Live Activity Feed</div>
              <div className="flex gap-1">
                {['all', 'eth', 'base'].map(c => (
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
            <ActivityFeed activity={filteredActivity} />
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showAddModal && (
          <AddWalletModal onAdd={addWallet} onClose={() => setShowAddModal(false)} />
        )}
      </AnimatePresence>
    </div>
  )
}
