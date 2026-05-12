import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import './index.css'
import WalletProvider from './components/shared/WalletProvider'

import { useAuthStore } from './store'
import AuthPage from './pages/AuthPage'
import DashboardLayout from './pages/DashboardLayout'
import OverviewPage from './pages/OverviewPage'
import MintGuardPage from './pages/MintGuardPage'
import WhaleRadarPage from './pages/WhaleRadarPage'
import AlphaPage from './pages/AlphaPage'
import SettingsPage from './pages/SettingsPage'
import AdminPage from './pages/AdminPage'
import Paywall from './components/Paywall'
import { useSubscription } from './hooks/useSubscription'
import { useAccount } from 'wagmi'
import { planLabel } from './lib/access'

const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0.05),
  })
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore()
  const { address, isConnected } = useAccount()
  const { subscription, hasBasicAccess, loading: subLoading, refresh } = useSubscription()

  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET

  if (loading || subLoading) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-muted text-sm font-mono">Loading Alpha Hub...</span>
      </div>
    </div>
  )

  if (!user) return <Navigate to="/auth" replace />
  if (isAdmin) return children
  if (!subscription || !hasBasicAccess) return <Paywall onSuccess={refresh} />
  return children
}

function PremiumRoute({ children, requiredPlan = 'pro', featureName = 'this feature' }) {
  const { address, isConnected } = useAccount()
  const { subscription, isPending, isExpired, loading, refresh, hasAccess } = useSubscription()
  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET

  if (loading) return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (isAdmin || hasAccess(requiredPlan)) return children
  return (
    <Paywall
      onSuccess={refresh}
      expired={isExpired || isPending}
      showBack
      requiredPlan={requiredPlan}
      lockMessage={`${featureName} requires ${planLabel(requiredPlan)}.`}
      currentPlan={subscription?.status === 'pending_verification' ? 'pending' : subscription?.plan || 'free'}
    />
  )
}

function AdminRoute({ children }) {
  const { address, isConnected } = useAccount()
  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET
  if (!isAdmin) return <Navigate to="/" replace />
  return children
}

function App() {
  const init = useAuthStore(s => s.init)
  const initialized = React.useRef(false)

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      init()
    }
  }, [])

  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/upgrade" element={<Paywall showBack />} />
          <Route path="/" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
            <Route index element={<OverviewPage />} />
            <Route path="mintguard" element={<PremiumRoute requiredPlan="free" featureName="MintGuard"><MintGuardPage /></PremiumRoute>} />
            <Route path="whaleradar" element={<PremiumRoute requiredPlan="free" featureName="WhaleRadar"><WhaleRadarPage /></PremiumRoute>} />
            <Route path="alpha" element={<PremiumRoute requiredPlan="pro" featureName="Wallet forensics"><AlphaPage /></PremiumRoute>} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="admin" element={<AdminRoute><AdminPage /></AdminRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: { background: '#0d1117', border: '1px solid #1a2332', color: '#d4e4f0', fontFamily: 'Inter' },
          success: { iconTheme: { primary: '#00c896', secondary: '#0d1117' } },
          error: { iconTheme: { primary: '#ff3d5a', secondary: '#0d1117' } },
        }}
      />
    </WalletProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
