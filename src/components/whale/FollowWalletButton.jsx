import React from 'react'
import { UserPlus, UserCheck } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuthStore, useWalletIntelStore } from '../../store'

export default function FollowWalletButton({ address, chain = 'eth', label = '', className = '' }) {
  const { user } = useAuthStore()
  const { isFollowing, getWatchEntry, followWallet, unfollowWallet, loading } = useWalletIntelStore()

  if (!user || !address) return null

  const following = isFollowing(address, chain)
  const entry = getWatchEntry(address, chain)

  const handleToggle = async () => {
    if (following && entry) {
      const { error } = await unfollowWallet(user.id, entry.id)
      if (error) toast.error('Could not unfollow wallet')
    } else {
      const { error } = await followWallet(user.id, address, label || 'Unlabeled', chain)
      if (error) toast.error('Could not follow wallet')
      else toast.success('Wallet added to Whale Radar')
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      title={following ? 'Unfollow wallet' : 'Follow wallet'}
      className={`p-1.5 rounded-md border transition-all
        ${following
          ? 'border-accent/40 text-accent bg-accent/8 hover:bg-accent/15'
          : 'border-border2 text-muted hover:border-accent hover:text-accent'}
        ${loading ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}`}
    >
      {following
        ? <UserCheck size={12} className="fill-current" />
        : <UserPlus size={12} />}
    </button>
  )
}
