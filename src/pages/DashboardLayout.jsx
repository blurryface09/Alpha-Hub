import React, { useEffect, useState } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Shield, Radar, Search,
  Settings, Bell, LogOut, Menu, X, ChevronRight, Zap
} from 'lucide-react'
import { useAuthStore, useNotificationStore } from '../store'
import NotificationPanel from '../components/shared/NotificationPanel'

const NAV_ITEMS = [
  { path: '/',          label: 'Overview',      icon: LayoutDashboard, exact: true },
  { path: '/mintguard', label: 'MintGuard',     icon: Shield,          badge: 'NEW' },
  { path: '/whaleradar',label: 'WhaleRadar',    icon: Radar },
  { path: '/alpha',     label: 'Alpha Tools',   icon: Search },
  { path: '/settings',  label: 'Settings',      icon: Settings },
]

export default function DashboardLayout() {
  const { user, profile, signOut } = useAuthStore()
  const { notifications, unreadCount, fetch: fetchNotifs, subscribe, markAllRead } = useNotificationStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (user) {
      fetchNotifs(user.id)
      const unsub = subscribe(user.id)
      return unsub
    }
  }, [user])

  const handleSignOut = async () => {
    await signOut()
    navigate('/auth')
  }

  return (
    <div className="min-h-screen bg-bg flex">
      {/* Mobile overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-20 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        className={`fixed top-0 left-0 h-full w-60 bg-surface border-r border-border z-30 flex flex-col
                    transform transition-transform duration-200 lg:translate-x-0 lg:static lg:flex
                    ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b border-border flex items-center justify-between">
          <div>
            <div className="font-mono text-base font-bold text-accent tracking-widest">ALPHA/HUB</div>
            <div className="text-xs text-muted mt-0.5">On-Chain Intelligence</div>
          </div>
          <button className="lg:hidden text-muted" onClick={() => setSidebarOpen(false)}>
            <X size={16} />
          </button>
        </div>

        {/* Status indicator */}
        <div className="mx-4 mt-3 mb-1 px-3 py-2 bg-surface2 rounded-lg border border-border flex items-center gap-2">
          <div className="dot-live" />
          <span className="text-xs text-muted font-mono">ETH · BASE · LIVE</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.exact}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              onClick={() => setSidebarOpen(false)}
            >
              <item.icon size={16} />
              <span className="flex-1">{item.label}</span>
              {item.badge && <span className="badge badge-cyan text-[10px]">{item.badge}</span>}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="px-3 py-3 border-t border-border">
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface2 mb-1">
            <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-accent text-xs font-bold">
              {(profile?.username || user?.email)?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{profile?.username || 'User'}</div>
              <div className="text-[10px] text-muted truncate">{user?.email}</div>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:text-accent2 rounded-lg transition-colors"
          >
            <LogOut size={13} />
            Sign Out
          </button>
        </div>
      </motion.aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-surface/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
          <button
            className="lg:hidden text-muted hover:text-text"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>

          <div className="flex-1" />

          {/* Notification bell */}
          <div className="relative">
            <button
              onClick={() => setNotifOpen(!notifOpen)}
              className="relative p-2 text-muted hover:text-text rounded-lg hover:bg-surface2 transition-colors"
            >
              <Bell size={18} />
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 w-4 h-4 bg-accent2 rounded-full text-[10px] font-bold text-white flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            <AnimatePresence>
              {notifOpen && (
                <NotificationPanel
                  notifications={notifications}
                  unreadCount={unreadCount}
                  onMarkAllRead={() => markAllRead(user.id)}
                  onClose={() => setNotifOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>

          {/* Wallet address display */}
          {profile?.wallet_address && (
            <div className="hidden sm:flex items-center gap-2 bg-surface2 border border-border rounded-lg px-3 py-1.5">
              <Zap size={12} className="text-accent" />
              <span className="font-mono text-xs text-muted">
                {profile.wallet_address.slice(0, 6)}...{profile.wallet_address.slice(-4)}
              </span>
            </div>
          )}
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="p-4 lg:p-6 max-w-7xl mx-auto"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  )
}
