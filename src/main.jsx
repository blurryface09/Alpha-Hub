import React, { useEffect } from ‘react’
import ReactDOM from ‘react-dom/client’
import { BrowserRouter, Routes, Route, Navigate } from ‘react-router-dom’
import { Toaster } from ‘react-hot-toast’
import ‘./index.css’
import WalletProvider from ‘./components/shared/WalletProvider’

import { useAuthStore } from ‘./store’
import AuthPage from ‘./pages/AuthPage’
import DashboardLayout from ‘./pages/DashboardLayout’
import OverviewPage from ‘./pages/OverviewPage’
import MintGuardPage from ‘./pages/MintGuardPage’
import WhaleRadarPage from ‘./pages/WhaleRadarPage’
import AlphaPage from ‘./pages/AlphaPage’
import SettingsPage from ‘./pages/SettingsPage’
import Paywall from ‘./components/Paywall’
import { useSubscription } from ‘./hooks/useSubscription’
import { useAccount } from ‘wagmi’

const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()

function ProtectedRoute({ children }) {
const { user, loading } = useAuthStore()
const { address, isConnected } = useAccount()
const { isActive, loading: subLoading, refresh } = useSubscription()

const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET

if (loading || subLoading) return (
<div className="min-h-screen bg-bg flex items-center justify-center">
<div className="flex flex-col items-center gap-3">
<div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
<span className="text-muted text-sm font-mono">Loading Alpha Hub…</span>
</div>
</div>
)

// Not logged in via Supabase auth — go to auth page
if (!user) return <Navigate to="/auth" replace />

// Admin wallet — bypass paywall
if (isAdmin) return children

// No active subscription — show paywall
if (!isActive) return <Paywall onSuccess={refresh} />

// Active subscription — let them in
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
<Route path=”/auth” element={<AuthPage />} />
<Route path=”/” element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
<Route index element={<OverviewPage />} />
<Route path=“mintguard” element={<MintGuardPage />} />
<Route path=“whaleradar” element={<WhaleRadarPage />} />
<Route path=“alpha” element={<AlphaPage />} />
<Route path=“settings” element={<SettingsPage />} />
</Route>
</Routes>
</BrowserRouter>
<Toaster
position=“bottom-right”
toastOptions={{
style: { background: ‘#0d1117’, border: ‘1px solid #1a2332’, color: ‘#d4e4f0’, fontFamily: ‘Inter’ },
success: { iconTheme: { primary: ‘#00c896’, secondary: ‘#0d1117’ } },
error: { iconTheme: { primary: ‘#ff3d5a’, secondary: ‘#0d1117’ } },
}}
/>
</WalletProvider>
)
}

ReactDOM.createRoot(document.getElementById(‘root’)).render(<App />)