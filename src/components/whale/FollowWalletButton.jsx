import React from 'react'
import { Bell, BellOff } from 'lucide-react'
import { useWalletFollowStore } from '../../store'

/**
 * Lightweight follow toggle for a wallet address.
 * State is persisted to localStorage — never touches whale_watchlist,
 * so toggling cannot cause row disappearance.
 */
export default function FollowWalletButton({ address, chain = 'eth', className = '' }) {
  const { isFollowing, toggle } = useWalletFollowStore()
  if (!address) return null

  const following = isFollowing(address, chain)

  return (
    <button
      onClick={() => toggle(address, chain)}
      title={following ? 'Unfollow alerts' : 'Follow for alerts'}
      className={`p-1.5 rounded-md border transition-all
        ${following
          ? 'border-accent/40 text-accent bg-accent/8 hover:bg-accent/15'
          : 'border-border2 text-muted hover:border-accent hover:text-accent'}
        ${className}`}
    >
      {following
        ? <Bell size={12} className="fill-current" />
        : <BellOff size={12} />}
    </button>
  )
}
