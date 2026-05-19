import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Bell, X, Check, Filter } from 'lucide-react'
import { useNotificationStore } from '../../store'
import { AlertTypeBadge, SeverityDot, getTypeIcon, getTypeColor } from './AlertBadge'

// Alerts that belong to the "whale" filter tab (whale_move excluded — too generic)
const WHALE_TYPES = new Set(['whale_mint', 'wallet_entry', 'wallet_repeat_mint', 'wallet_large_mint'])
// Alerts that belong to the "project" filter tab
const PROJECT_TYPES = new Set([
  'project_live', 'stealth_delay', 'schedule_changed', 'price_changed',
  'supply_changed', 'contract_deployed', 'project_cancelled', 'status_changed',
  'mint_live', 'mint_success', 'mint_failed',
])

const TABS = [
  { key: 'all',     label: 'All' },
  { key: 'project', label: 'Projects' },
  { key: 'whale',   label: 'Whale' },
]

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function AlertRow({ notification, onMarkRead }) {
  const severity = notification.data?.severity
  const Icon     = getTypeIcon(notification.type)
  const color    = getTypeColor(notification.type)

  return (
    <div
      onClick={() => !notification.read && onMarkRead(notification.id)}
      className={`flex gap-3 px-4 py-3 border-b border-border last:border-0 cursor-pointer transition-colors
        ${notification.read ? 'opacity-50' : 'hover:bg-surface2/60'}`}
    >
      {/* Severity dot */}
      {!notification.read && severity && (
        <div className="flex-shrink-0 mt-1.5">
          <SeverityDot severity={severity} />
        </div>
      )}
      {(notification.read || !severity) && (
        <div className={`flex-shrink-0 mt-1 ${color}`}>
          <Icon size={13} />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <span className="text-xs font-semibold leading-tight">{notification.title}</span>
          <AlertTypeBadge type={notification.type} />
        </div>
        <p className="text-xs text-muted leading-relaxed line-clamp-2">
          {notification.message}
        </p>
        <span className="text-[10px] text-muted2 mt-0.5 block">
          {relativeTime(notification.created_at)}
        </span>
      </div>

      {!notification.read && (
        <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 flex-shrink-0" />
      )}
    </div>
  )
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export default function AlertCenter({ notifications, unreadCount, onMarkAllRead, onClose }) {
  const { markRead } = useNotificationStore()
  const [activeTab, setActiveTab] = useState('all')

  const recent = notifications.filter(n =>
    Date.now() - new Date(n.created_at).getTime() < SEVEN_DAYS_MS
  )

  const filtered = recent.filter(n => {
    if (activeTab === 'all')     return true
    if (activeTab === 'whale')   return WHALE_TYPES.has(n.type)
    if (activeTab === 'project') return PROJECT_TYPES.has(n.type)
    return true
  })

  const tabUnread = (tab) => {
    if (tab === 'all') return recent.filter(n => !n.read).length
    return recent.filter(n => {
      if (!n.read) {
        if (tab === 'whale')   return WHALE_TYPES.has(n.type)
        if (tab === 'project') return PROJECT_TYPES.has(n.type)
      }
      return false
    }).length
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.15 }}
      className="absolute right-0 top-full mt-2 w-88 bg-surface border border-border rounded-xl shadow-2xl z-50 overflow-hidden"
      style={{ width: '22rem' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Bell size={13} className="text-accent" />
          <span className="text-sm font-semibold">Alerts</span>
          {unreadCount > 0 && (
            <span className="badge badge-red text-[10px] min-w-[18px] text-center">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {tabUnread('all') > 0 && (
            <button
              onClick={onMarkAllRead}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
            >
              <Check size={11} />
              Mark all read
            </button>
          )}
          <button onClick={onClose} className="text-muted hover:text-text p-0.5">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-border px-1">
        {TABS.map(tab => {
          const count = tabUnread(tab.key)
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors
                ${activeTab === tab.key
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-text'}`}
            >
              {tab.label}
              {count > 0 && (
                <span className="text-[9px] bg-accent/20 text-accent rounded-full px-1 min-w-[16px] text-center">
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Alert list */}
      <div className="max-h-96 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center gap-2 px-4">
            <Bell size={20} className="text-muted2" />
            <p className="text-xs font-semibold text-text">
              {activeTab === 'all' ? 'No recent alerts' : `No ${activeTab} alerts`}
            </p>
            <p className="text-[10px] text-muted2 leading-relaxed">
              {activeTab === 'all'
                ? 'Watch a project or wallet to start receiving alerts here.'
                : activeTab === 'whale'
                  ? 'Add wallets in Watchlist to get mint and entry alerts.'
                  : 'Follow a project in MintGuard to get live status alerts.'}
            </p>
          </div>
        ) : (
          filtered.map(n => (
            <AlertRow
              key={n.id}
              notification={n}
              onMarkRead={markRead}
            />
          ))
        )}
      </div>

      {/* Footer */}
      {filtered.length > 0 && (
        <div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
          <span className="text-[10px] text-muted2">
            {filtered.length} alert{filtered.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-1 text-[10px] text-muted2">
            <Filter size={9} />
            <span>Monitoring active</span>
            <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
          </div>
        </div>
      )}
    </motion.div>
  )
}
