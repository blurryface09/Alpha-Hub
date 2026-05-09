import { useSubscription } from '../hooks/useSubscription'
import { useAccount } from 'wagmi'
import Paywall from './Paywall'
import { Loader2 } from 'lucide-react'

const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()

export default function SubscriptionGate({ children }) {
  const { isConnected, address } = useAccount()
  const { isActive, loading, refresh } = useSubscription()

  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET

  if (loading && !isAdmin) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
      </div>
    )
  }

  if (!isConnected || (!isActive && !isAdmin)) {
    return <Paywall onSuccess={refresh} />
  }

  return children
}
