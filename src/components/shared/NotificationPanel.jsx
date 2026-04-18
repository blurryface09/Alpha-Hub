import React from 'react'
import { motion } from 'framer-motion'
import { Bell, Check, X, Shield, Radar, Zap, AlertTriangle } from 'lucide-react'
import { useNotificationStore } from '../../store'

const TYPE_ICONS = {
  mint_live:    { icon: Zap,           color: 'text-green' },
  mint_success: { icon: Check,         color: 'text-green' },
  mint_failed:  { icon: X,             color: 'text-accent2' },
  whale_move:   { icon: Radar,         color: 'text-accent' },
  whale_mint:   { icon: Zap,           color: 'text-green' },
  rug_alert:    { icon: AlertTriangle,  color: 'text-accent2' },
  system:       { icon: Bell,           color: 'text-muted' },
}

export default function NotificationPanel({ notifications, unreadCount, onMarkAllRead, onClose }) {
  const { markRead } = useNotificationStore()

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      className="absolute right-0 top-full mt-2 w-80 bg-surface border border-border rounded-xl shadow-2xl z-50 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-accent" />
          <span className="text-sm font-semibold">Alerts</span>
          {unreadCount > 0 && (
            <span className="badge badge-red text-[10px]">{unreadCount}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button onClick={onMarkAllRead} className="text-xs text-accent hover:underline">
              Mark all read
            </button>
          )}
          <button onClick={onClose} className="text-muted hover:text-text">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="max-h-96 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="text-center py-8 text-muted text-sm">No alerts yet</div>
        ) : (
          notifications.map(n => {
            const { icon: Icon, color } = TYPE_ICONS[n.type] || TYPE_ICONS.system
            return (
              <div
                key={n.id}
                onClick={() => !n.read && markRead(n.id)}
                className={`flex gap-3 px-4 py-3 border-b border-border last:border-0 cursor-pointer transition-colors
                  ${n.read ? 'opacity-60' : 'bg-accent/3 hover:bg-surface2'}`}
              >
                <div className={`mt-0.5 flex-shrink-0 ${color}`}>
                  <Icon size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold leading-tight">{n.title}</div>
                  <div className="text-xs text-muted mt-0.5 line-clamp-2 leading-relaxed">{n.message}</div>
                  <div className="text-[10px] text-muted2 mt-1">
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
                {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 flex-shrink-0" />}
              </div>
            )
          })
        )}
      </div>
    </motion.div>
  )
}
