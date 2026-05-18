import React from 'react'
import { Bell, BellOff } from 'lucide-react'
import { useAuthStore, useMonitorStore } from '../../store'

/**
 * Follow/unfollow toggle badge for a calendar project.
 * Shows "Watching" when following, "Watch" when not.
 * Compact enough to embed in ProjectCard or CalendarCard.
 */
export default function MonitoringBadge({ projectId, className = '' }) {
  const { user } = useAuthStore()
  const { watchedProjects, follow, unfollow, loading } = useMonitorStore()

  if (!user || !projectId) return null

  const isWatching = watchedProjects.has(projectId)

  const handleToggle = async (e) => {
    e.stopPropagation()
    if (!user?.id) return
    if (isWatching) {
      await unfollow(user.id, projectId)
    } else {
      await follow(user.id, projectId)
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      title={isWatching ? 'Unfollow project' : 'Follow project for alerts'}
      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-all
        ${isWatching
          ? 'border-accent/40 text-accent bg-accent/8 hover:bg-accent/15'
          : 'border-border2 text-muted hover:border-accent/40 hover:text-accent hover:bg-accent/5'
        } ${className}`}
    >
      {isWatching
        ? <Bell size={11} className="fill-current" />
        : <BellOff size={11} />
      }
      {isWatching ? 'Watching' : 'Watch'}
    </button>
  )
}
