import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  Bell,
  Clock,
  Compass,
  Radar,
  Send,
  Signal,
  Wallet,
  Zap,
} from 'lucide-react'
import { useAuthStore, useNotificationStore, useWhaleStore } from '../store'
import { useSubscription } from '../hooks/useSubscription'
import { supabase } from '../lib/supabase'

function timeAgo(value) {
  if (!value) return 'never'
  const deltaSeconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  const future = deltaSeconds < 0
  const seconds = Math.abs(deltaSeconds)
  const suffix = future ? '' : ' ago'
  const prefix = future ? 'in ' : ''
  if (seconds < 10) return future ? 'now' : 'just now'
  if (seconds < 60) return `${prefix}${seconds}s${suffix}`
  if (seconds < 3600) return `${prefix}${Math.floor(seconds / 60)}m${suffix}`
  if (seconds < 86400) return `${prefix}${Math.floor(seconds / 3600)}h${suffix}`
  return `${prefix}${Math.floor(seconds / 86400)}d${suffix}`
}

function eventIcon(type) {
  if (type?.includes('whale')) return Radar
  if (type?.includes('mint')) return Zap
  if (type?.includes('telegram')) return Send
  if (type?.includes('rug')) return AlertTriangle
  return Bell
}

function eventTone(type) {
  if (type?.includes('failed') || type?.includes('rug')) return 'text-accent2'
  if (type?.includes('success') || type?.includes('live')) return 'text-green'
  if (type?.includes('whale')) return 'text-accent'
  return 'text-accent3'
}

export default function OverviewPage() {
  const { user, profile } = useAuthStore()
  const { notifications, unreadCount, fetch: fetchNotifications } = useNotificationStore()
  const { activity, fetch: fetchWhaleActivity } = useWhaleStore()
  const { subscription, isActive, daysRemaining, plan } = useSubscription()
  const [stats, setStats] = useState({
    activeAutomints: 0,
    activeAlerts: 0,
    activeProjects: 0,
    totalProjects: 0,
    walletsTracked: 0,
    minted: 0,
    telegramConnected: false,
    lastSync: null,
  })
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  const loadCommandCenter = React.useCallback(async () => {
    if (!user) return
    setLoading(true)

    try {
      const [
        projectResult,
        watchlistResult,
        activeAlertResult,
        mintedResult,
        profileResult,
      ] = await Promise.all([
        supabase
          .from('wl_projects')
          .select('id, name, status, mint_date, mint_mode, auto_mint_fired, contract_address, chain')
          .eq('user_id', user.id)
          .order('mint_date', { ascending: true, nullsFirst: false })
          .limit(12),
        supabase
          .from('whale_watchlist')
          .select('id, last_checked', { count: 'exact' })
          .eq('user_id', user.id)
          .eq('is_active', true),
        supabase
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('read', false),
        supabase
          .from('wl_projects')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'minted'),
        supabase
          .from('profiles')
          .select('telegram_chat_id')
          .eq('id', user.id)
          .maybeSingle(),
      ])

      await Promise.all([
        fetchNotifications(user.id),
        fetchWhaleActivity(user.id),
      ])

      if (projectResult.error) console.error('overview projects error:', projectResult.error.message)
      if (watchlistResult.error) console.error('overview watchlist error:', watchlistResult.error.message)
      if (activeAlertResult.error) console.error('overview alerts error:', activeAlertResult.error.message)
      if (mintedResult.error) console.error('overview minted error:', mintedResult.error.message)
      if (profileResult.error) console.error('overview profile error:', profileResult.error.message)

      const userProjects = projectResult.data || []
      const watchlist = watchlistResult.data || []
      const latestWalletSync = watchlist
        .map((wallet) => wallet.last_checked)
        .filter(Boolean)
        .sort()
        .at(-1)

      setProjects(userProjects)
      setStats({
        activeAutomints: userProjects.filter((p) =>
          p.status === 'live' &&
          p.mint_mode === 'auto' &&
          p.contract_address &&
          !p.auto_mint_fired
        ).length,
        activeAlerts: activeAlertResult.count || 0,
        activeProjects: userProjects.filter((p) => ['upcoming', 'live'].includes(p.status)).length,
        totalProjects: userProjects.length,
        walletsTracked: watchlistResult.count || 0,
        minted: mintedResult.count || 0,
        telegramConnected: Boolean(profileResult.data?.telegram_chat_id),
        lastSync: latestWalletSync || new Date().toISOString(),
      })
    } finally {
      setLoading(false)
    }
  }, [fetchNotifications, fetchWhaleActivity, user])

  useEffect(() => {
    if (!user) return

    let cancelled = false
    const safeLoad = async () => {
      if (!cancelled) await loadCommandCenter()
    }

    safeLoad()
    const interval = setInterval(safeLoad, 30000)
    const onResume = () => safeLoad()
    window.addEventListener('alphahub:resume', onResume)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('alphahub:resume', onResume)
    }
  }, [user, loadCommandCenter])

  const liveFeed = useMemo(() => {
    const notificationEvents = notifications.slice(0, 12).map((n) => ({
      id: `notification-${n.id}`,
      type: n.type || 'system',
      title: n.title,
      message: n.message,
      at: n.created_at,
    }))

    const whaleEvents = activity.slice(0, 12).map((a, index) => ({
      id: `whale-${a.id || a.tx_hash || index}`,
      type: a.is_mint ? 'whale_mint' : 'whale_move',
      title: `${a.wallet_label || a.wallet_address?.slice(0, 10) || 'Wallet'} ${a.method_name || 'activity'}`,
      message: `${a.value_eth ?? 0} ${a.chain === 'bnb' ? 'BNB' : 'ETH'} on ${(a.chain || 'eth').toUpperCase()}`,
      at: a.timestamp || a.created_at,
    }))

    const mintEvents = projects
      .filter((p) => ['upcoming', 'live'].includes(p.status))
      .slice(0, 8)
      .map((p) => ({
        id: `project-${p.id}`,
        type: p.status === 'live' ? 'mint_live' : 'mint_countdown',
        title: p.status === 'live' ? `${p.name} is live` : `${p.name} countdown active`,
        message: p.mint_date ? `Mint ${timeAgo(p.mint_date)}` : 'Mint date pending',
        at: p.status === 'live' ? new Date().toISOString() : p.mint_date,
      }))

    const realEvents = [...notificationEvents, ...whaleEvents, ...mintEvents]
      .filter((event) => event.title)
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .slice(0, 12)
    return realEvents
  }, [activity, notifications, projects])

  const summary = [
    { label: 'Live alerts', value: stats.activeAlerts, icon: Bell, tone: stats.activeAlerts ? 'text-accent2' : 'text-muted', hint: 'Unread signals waiting for you' },
    { label: 'Tracked mints', value: stats.totalProjects, icon: Clock, tone: 'text-accent3', hint: 'Projects saved to MintGuard' },
    { label: 'Wallets watched', value: stats.walletsTracked, icon: Wallet, tone: 'text-accent', hint: 'Smart wallets on your radar' },
    { label: 'Strike Mode', value: stats.activeAutomints ? 'Armed' : 'Off', icon: Zap, tone: stats.activeAutomints ? 'text-green' : 'text-muted', hint: 'Opt-in only' },
  ]

  const upcomingMints = projects.filter((p) => p.status === 'upcoming').length
  const recentWhaleAlerts = activity.filter((a) => !a.is_mint).slice(0, 10).length
  const lastDetection = [...activity]
    .map((a) => a.timestamp || a.created_at)
    .filter(Boolean)
    .sort()
    .at(-1)

  const userValueItems = [
    { label: 'Active Monitors', value: stats.walletsTracked + stats.activeProjects, icon: Signal, tone: 'text-accent' },
    { label: 'Recent Whale Alerts', value: recentWhaleAlerts, icon: Radar, tone: 'text-accent' },
    { label: 'Upcoming Mints', value: upcomingMints, icon: Clock, tone: 'text-accent3' },
    { label: 'MintGuard Status', value: stats.activeAutomints ? 'Armed' : 'Watching', icon: Zap, tone: stats.activeAutomints ? 'text-green' : 'text-muted' },
    { label: 'Wallets Tracked', value: stats.walletsTracked, icon: Wallet, tone: 'text-accent' },
    { label: 'Last Detection', value: timeAgo(lastDetection), icon: Activity, tone: 'text-green' },
    {
      label: 'Subscription',
      value: isActive ? `${subscription?.plan || 'active'} (${daysRemaining}d)` : 'inactive',
      icon: Bell,
      tone: isActive ? 'text-green' : 'text-accent3',
    },
  ]

  return (
    <div className="space-y-5">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="hero-panel"
      >
        <div className="hero-content flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs text-accent font-mono mb-3">
              <span className="dot-live" />
              Today’s Alpha
            </div>
            <h1 className="text-3xl sm:text-4xl font-black mb-2">What should you watch next?</h1>
            <p className="text-sm sm:text-base text-muted max-w-2xl">
              Your friendly Web3 radar for live opportunities, wallet signals, upcoming mints, and community picks.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Link to="/calendar" className="btn-primary text-center">Open Alpha Radar</Link>
            <Link to="/mintguard" className="btn-ghost text-center">Add Alpha</Link>
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {summary.map((item, index) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03 }}
            className="metric-card min-h-[118px]"
          >
            <div className="flex items-center justify-between mb-3">
              <item.icon size={15} className={item.tone} />
            </div>
            <div className={`text-xl font-bold ${item.tone}`}>{loading ? '-' : item.value}</div>
            <div className="section-label mt-1 mb-0">{item.label}</div>
            <div className="text-[11px] text-muted mt-2">{item.hint}</div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        <section className="card min-h-[480px]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="section-label mb-1">Live Signals</div>
              <h2 className="text-base font-semibold">Fresh things worth checking</h2>
            </div>
            <Link to="/calendar" className="btn-ghost text-xs py-2 px-3">
              Browse Alpha Radar
            </Link>
          </div>

          {liveFeed.length === 0 ? (
            <div className="empty-state flex flex-col items-center justify-center py-16">
              <div className="mascot-orb mb-4">✧</div>
              <p className="text-base text-text font-semibold">No alpha stream yet</p>
              <p className="text-sm text-muted mt-2 max-w-md">Start by discovering a project, watching a wallet, or adding a mint you already care about.</p>
              <div className="flex gap-2 mt-4">
                <Link to="/calendar" className="btn-primary text-xs">Alpha Radar</Link>
                <Link to="/whaleradar" className="btn-ghost text-xs">Watch Wallet</Link>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {liveFeed.map((event) => {
                const Icon = eventIcon(event.type)
                const tone = eventTone(event.type)
                return (
                  <div key={event.id} className="flex gap-3 py-3">
                    <div className={`mt-1 h-8 w-8 rounded-lg bg-surface2 border border-border flex items-center justify-center ${tone}`}>
                      <Icon size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm font-semibold truncate">{event.title}</div>
                        <div className="text-[11px] font-mono text-muted whitespace-nowrap">{timeAgo(event.at)}</div>
                      </div>
                      <div className="text-xs text-muted mt-1 line-clamp-2">{event.message}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <section className="card">
            <div className="section-label">Your Next Moves</div>
            <div className="space-y-3">
              {userValueItems.slice(0, 5).map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <div className={`h-8 w-8 rounded-lg bg-surface2 border border-border flex items-center justify-center ${item.tone}`}>
                    <item.icon size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{item.label}</div>
                    <div className="text-xs text-muted truncate">{item.value}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="section-label">Progress</div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">Alpha tracked</span>
                <span className="font-mono text-sm text-green">{stats.minted}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">Unread alerts</span>
                <span className="font-mono text-sm text-accent">{unreadCount}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">Feed events</span>
                <span className="font-mono text-sm text-accent3">{liveFeed.length}</span>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-label">Quick Actions</div>
            <div className="grid gap-2">
              <Link to="/calendar" className="btn-primary text-center flex items-center justify-center gap-2"><Compass size={15} /> Find Alpha</Link>
              <Link to="/mintguard" className="btn-ghost text-center">Add a Mint</Link>
              <Link to="/settings" className="btn-ghost text-center">Set Alerts</Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
