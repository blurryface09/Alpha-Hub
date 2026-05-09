import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { supabase } from '../lib/supabase'

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
      const { data, error: fetchError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('wallet_address', address.toLowerCase())
        .eq('verified', true)
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: false })
        .limit(1)
        .single()

      if (fetchError && fetchError.code !== 'PGRST116') {
        setError(fetchError.message)
      }

      setSubscription(data || null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [address, isConnected])

  useEffect(() => {
    checkSubscription()
  }, [checkSubscription])

  const isActive = !!subscription

  const daysRemaining = subscription
    ? Math.max(0, Math.ceil(
        (new Date(subscription.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
      ))
    : 0

  return {
    subscription,
    isActive,
    daysRemaining,
    loading,
    error,
    refresh: checkSubscription,
  }
}
