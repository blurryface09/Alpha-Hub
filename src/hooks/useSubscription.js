import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { getAuthToken } from '../lib/supabase'

export function useSubscription() {
  const { address, isConnected } = useAccount()
  const [subscription, setSubscription] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const checkSubscription = useCallback(async () => {
    if (!isConnected || !address) {
      setSubscription(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again to check your subscription')
      const res = await fetch('/api/subscription?walletAddress=' + encodeURIComponent(address.toLowerCase()), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Subscription check failed')
      setSubscription(data.subscription || null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [address, isConnected])

  useEffect(() => {
    checkSubscription()
  }, [checkSubscription])

  const isActive = !!subscription &&
    subscription.status === 'active' &&
    !!subscription.expires_at &&
    new Date(subscription.expires_at) > new Date()
  const isFree = subscription?.status === 'free' || subscription?.plan === 'free'
  const isPending = subscription?.status === 'pending_verification'
  const hasBasicAccess = isActive || isFree || isPending
  const isExpired = !!subscription && !isActive && !isFree && !isPending

  const daysRemaining = subscription
    ? Math.max(0, Math.ceil(
        (new Date(subscription.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
      ))
    : 0

  return {
    subscription,
    isActive,
    isFree,
    isPending,
    hasBasicAccess,
    isExpired,
    daysRemaining,
    loading,
    error,
    refresh: checkSubscription,
  }
}
