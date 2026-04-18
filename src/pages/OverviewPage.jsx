import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Shield, Radar, Search, Bell, TrendingUp, Zap, ChevronRight, Activity } from 'lucide-react'
import { useAuthStore, useNotificationStore, useWhaleStore } from '../store'
import { supabase } from '../lib/supabase'

export default function OverviewPage() {
  const { user, profile } = useAuthStore()
  const { notifications, unreadCount } = useNotificationStore()
  const { activity } = useWhaleStore()
  const [stats, setStats] = useState({ projects: 0, watchlist: 0, minted: 0 })

  useEffect(() => {
    if (!user) return
    const fetchStats = async () => {
      const [{ count: projects }, { count: watchlist }, { count: minted }] = await Promise.all([
        supabase.from('wl_projects').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('whale_watchlist').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('wl_projects').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'minted'),
      ])
      setStats({ projects: projects || 0, watchlist: watchlist || 0, minted: minted || 0 })
    }
    fetchStats()
  }, [user])

  const recentNotifs = notifications.slice(0, 5)
  const recentActivity = activity.slice(0, 5)
  const mintActivity = activity.filter(a => a.is_mint).slice(0, 3)

  const modules = [
    {
      path: '/mintguard',
      icon: Shield,
      label: 'MintGuard',
      desc: 'Track WL projects, set GTD/FCFS alerts, auto-execute mints.',
      stat: `${stats.projects} projects`,
      color: 'text-green',
      border: 'hover:border-green/40',
      glow: 'hover:glow-green',
    },
    {
      path: '/whaleradar',
      icon: Radar,
      label: 'WhaleRadar',
      desc: "Track smart money wallets. See what they're minting in real-time.",
      stat: `${stats.watchlist} wallets`,
      color: 'text-accent',
      border: 'hover:border-accent/40',
      glow: 'hover:glow-accent',
    },
    {
      path: '/alpha',
      icon: Search,
      label: 'Alpha Tools',
      desc: 'Forensic wallet analysis, contract auditing, jeet detection.',
      stat: 'ETH + Base',
      color: 'text-purple',
      border: 'hover:border-purple/40',
    },
  ]

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-bold mb-0.5">
          gm, {profile?.username || 'anon'} 👋
        </h1>
        <p className="text-muted text-sm">Your on-chain intelligence dashboard.</p>
      </motion.div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'WL Projects', val: stats.projects, icon: Shield, color: 'text-green' },
          { label: 'Wallets Tracked', val: stats.watchlist, icon: Radar, color: 'text-accent' },
          { label: 'Mints Executed', val: stats.minted, icon: Zap, color: 'text-accent3' },
          { label: 'Unread Alerts', val: unreadCount, icon: Bell, color: unreadCount > 0 ? 'text-accent2' : 'text-muted' },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="metric-card"
          >
            <div className="flex items-center justify-between mb-1">
              <s.icon size={14} className={s.color} />
            </div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.val}</div>
            <div className="section-label mt-1 mb-0">{s.label}</div>
          </motion.div>
        ))}
      </div>

      {/* Module cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {modules.map((m, i) => (
          <motion.div
            key={m.path}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 + 0.1 }}
          >
            <Link
              to={m.path}
              className={`card block border transition-all duration-200 ${m.border} ${m.glow} group`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className={`p-2 rounded-lg bg-surface2 ${m.color}`}>
                  <m.icon size={16} />
                </div>
                <ChevronRight size={14} className="text-muted group-hover:text-text transition-colors" />
              </div>
              <div className="font-bold text-base mb-1">{m.label}</div>
              <p className="text-xs text-muted leading-relaxed mb-3">{m.desc}</p>
              <div className={`text-xs font-mono ${m.color}`}>{m.stat}</div>
            </Link>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent whale mints */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="section-label mb-0">🟢 Recent Whale Mints</div>
            <Link to="/whaleradar" className="text-xs text-accent hover:underline">View all</Link>
          </div>
          {mintActivity.length === 0 ? (
            <p className="text-muted text-sm py-4 text-center">No mint activity yet. Add wallets to WhaleRadar.</p>
          ) : (
            <div className="space-y-0">
              {mintActivity.map((a, i) => (
                <div key={i} className="tx-row">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{a.wallet_label || a.wallet_address?.slice(0, 14) + '...'}</div>
                    <div className="text-xs text-muted">{a.method_name} · {a.chain?.toUpperCase()}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm text-green font-mono">{a.value_eth?.toFixed(3)} ETH</div>
                    <div className="text-xs text-muted">{a.timestamp ? new Date(a.timestamp).toLocaleTimeString() : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent notifications */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="section-label mb-0">Recent Alerts</div>
            {unreadCount > 0 && (
              <span className="badge badge-red text-[10px]">{unreadCount} unread</span>
            )}
          </div>
          {recentNotifs.length === 0 ? (
            <p className="text-muted text-sm py-4 text-center">No alerts yet. Alerts appear here in real-time.</p>
          ) : (
            <div className="space-y-2">
              {recentNotifs.map(n => (
                <div key={n.id} className={`p-3 rounded-lg border text-sm ${n.read ? 'bg-surface2 border-border' : 'bg-accent/5 border-accent/20'}`}>
                  <div className="font-medium text-sm mb-0.5">{n.title}</div>
                  <div className="text-xs text-muted line-clamp-2">{n.message}</div>
                  <div className="text-xs text-muted2 mt-1">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
