import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import './index.css'

import { useAuthStore } from './store'
import AuthPage from './pages/AuthPage'
import DashboardLayout from './pages/DashboardLayout'
import OverviewPage from './pages/OverviewPage'
import MintGuardPage from './pages/MintGuardPage'
import WhaleRadarPage from './pages/WhaleRadarPage'
import AlphaPage from './pages/AlphaPage'
import SettingsPage from './pages/SettingsPage'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1 } }
})

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore()
  if (loading) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-muted text-sm font-mono">Loading Alpha Hub...</span>
      </div>
    </div>
  )
  return user ? children : <Navigate to="/auth" replace />
}

function App() {
  const init = useAuthStore(s => s.init)
  const initialized = React.useRef(false)
  
  useEffect(() => {
    // Only init once — prevents duplicate auth listeners
    if (!initialized.current) {
      initialized.current = true
      init()
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
            <Route index element={<OverviewPage />} />
            <Route path="mintguard" element={<MintGuardPage />} />
            <Route path="whaleradar" element={<WhaleRadarPage />} />
            <Route path="alpha" element={<AlphaPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
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
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
