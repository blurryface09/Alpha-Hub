import React from 'react'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from '../../lib/wallet'

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      // Swallow wagmi connector reconnection errors (stale WalletConnect sessions)
      // so they don't bubble up as unhandled promise rejections
      onError: (err) => {
        const msg = (err?.message || '').toLowerCase()
        if (msg.includes('getchainid') || (msg.includes('connector') && msg.includes('not a function'))) {
          // Stale connector session — clear wagmi.v2.store so next page load starts fresh
          try { localStorage.removeItem('wagmi.v2.store') } catch {}
          console.warn('[wagmi] stale connector session cleared')
        }
      },
    },
  },
})

export default function WalletProvider({ children }) {
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
