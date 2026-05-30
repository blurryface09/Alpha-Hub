import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useLocation } from 'react-router-dom'
import { Plus, Shield, Sparkles, Wand2, Loader, ExternalLink } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase, directInsert, directUpdate, directDelete, getAuthToken } from '../lib/supabase'
import { useMint } from '../hooks/useMint'
import { useSubscription } from '../hooks/useSubscription'
import { useAuthStore } from '../store'
import { friendlyError } from '../lib/errors'
import Paywall from '../components/Paywall'
import AddProjectModal from '../components/mint/AddProjectModal'
import MintConfirmModal from '../components/mint/MintConfirmModal'
import ProjectCard from '../components/mint/ProjectCard'
import StrikeReviewModal from '../components/mint/StrikeReviewModal'
import StrikeReplayModal from '../components/mint/StrikeReplayModal'

const STATUS_TABS = ['all', 'upcoming', 'live', 'minted', 'missed']
const OPTIONAL_PROJECT_FIELDS = [
  'automint_enabled',
  'max_mint_price',
  'max_gas_fee',
  'max_total_spend',
  'mint_time_source',
  'mint_time_confidence',
  'mint_time_confirmed',
  'mint_time_confirmed_at',
  'prepared_to',
  'prepared_data',
  'prepared_value',
  'prepared_chain_id',
  'execution_status',
]

// Send a notification to the user's Telegram (fire-and-forget)
async function notifyTelegram(project, type, userToken) {
  if (!userToken) return
  try {
    await fetch('/api/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + userToken,
      },
      body: JSON.stringify({ project, type }),
    })
  } catch {}
}

export default function MintGuardPage() {
  const location = useLocation()
  const { user } = useAuthStore()
  const { plan, limits, hasAccess, refresh } = useSubscription()
  const { executeMint: mintHook, isConnected } = useMint()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [showAddModal, setShowAddModal] = useState(false)
  const [initialContract, setInitialContract] = useState(null)
  const [initialChain, setInitialChain] = useState('eth')
  const [confirmMint, setConfirmMint] = useState(null) // project to confirm mint for
  const [mintingId, setMintingId] = useState(null)
  const [mintErrors, setMintErrors] = useState({}) // { [projectId]: { text, fault } }
  const [telegramChatId, setTelegramChatId] = useState(null)
  const [userToken, setUserToken] = useState(null)
  const [upgradeRequired, setUpgradeRequired] = useState(null)
  const [strikeReviewProject, setStrikeReviewProject] = useState(null) // project pending Strike Review
  const [vaultWallet, setVaultWallet] = useState(null) // cached vault for review modal
  const [deletingId, setDeletingId] = useState(null)
  const [replayProject, setReplayProject] = useState(null)
  const [replayIntentId, setReplayIntentId] = useState(null)
  const [pageImportLoading, setPageImportLoading] = useState(false)
  // pendingImportData: { url, meta, failed } — result of clipboard auto-import
  // passed to AddProjectModal so it opens pre-filled (or with failure banner)
  const [pendingImportData, setPendingImportData] = useState(null)
  const autoFired = React.useRef(new Set())
  // Persist notified set to sessionStorage so re-navigation doesn't re-send Telegram alerts
  const tgNotified = React.useRef((() => {
    try {
      const stored = sessionStorage.getItem('alphahub:tgNotified')
      return new Set(stored ? JSON.parse(stored) : [])
    } catch { return new Set() }
  })())
  // Always-current ref so the realtime subscription callback never has a stale closure
  const executeMintRef = React.useRef(null)

  // Auto-update project status based on mint date
  const autoUpdateStatus = async (projects) => {
    const now = new Date()
    const updates = []
    for (const p of projects) {
      if (!p.mint_date || p.status === 'minted' || p.status === 'cancelled') continue
      const mintDate = new Date(p.mint_date)
      const diffMs = now - mintDate
      const diffHours = diffMs / (1000 * 60 * 60)
      let newStatus = p.status
      if (diffMs < 0) {
        // Before mint date
        newStatus = 'upcoming'
      } else if (diffHours >= 0 && diffHours < 2) {
        // Within 2 hours of mint date = LIVE
        newStatus = 'live'
      } else if (diffHours >= 2) {
        // More than 2 hours past = MISSED
        newStatus = 'missed'
      }
      if (newStatus !== p.status) {
        updates.push({ id: p.id, status: newStatus })
      }
    }
    // Apply updates
    for (const u of updates) {
      await supabase.from('wl_projects').update({ status: u.status }).eq('id', u.id)
    }
    if (updates.length > 0) {
      return projects.map(p => {
        const update = updates.find(u => u.id === p.id)
        return update ? { ...p, status: update.status } : p
      })
    }
    return projects
  }

  const fetchProjects = useCallback(async (showLoader = false) => {
    if (!user) { setLoading(false); return }
    try {
      if (showLoader) setLoading(true)
      let query = supabase
        .from('wl_projects')
        .select('*')
        .eq('user_id', user.id)
        .neq('status', 'cancelled')
        .not('status', 'eq', 'archived')
        .order('mint_date', { ascending: true, nullsFirst: false })
      const { data, error } = await query
      if (error) { console.error('fetchProjects error:', error); return }
      if (Array.isArray(data)) {
        const visibleProjects = data.filter(project => (
          !project.deleted_at &&
          !['archived', 'cancelled'].includes(String(project.status || '').toLowerCase())
        ))
        const updated = await autoUpdateStatus(visibleProjects)
        setProjects(updated)
      }
    } catch(e) {
      console.error('fetchProjects catch:', e)
    } finally {
      setLoading(false)
    }
  }, [user])

  // First load with spinner, subsequent interval refreshes silent
  const lastVisibilityRefresh = React.useRef(0)
  // Track the last user ID that triggered a full reset — only clear+reload when user identity
  // actually changes (login/logout), not on token refresh which recreates fetchProjects with
  // the same user object reference before the store fix lands in all environments.
  const lastLoadedUserId = React.useRef(null)

  useEffect(() => {
    const currentUserId = user?.id ?? null
    const userChanged = currentUserId !== lastLoadedUserId.current
    lastLoadedUserId.current = currentUserId

    if (userChanged) {
      // Real identity change (login/logout) — reset everything and show spinner
      setProjects([])
      setLoading(true)
      fetchProjects(true)
    } else {
      // Same user, fetchProjects was silently recreated (e.g. stale closure) — refresh quietly
      fetchProjects(false)
    }

    if (location.state?.openAdd) {
      setShowAddModal(true)
      setInitialContract(location.state.contract)
      setInitialChain(location.state.chain)
    }

    // Silent background refresh every 60s — never clears projects
    const interval = setInterval(() => fetchProjects(false), 60000)

    // Re-fetch when tab/app becomes visible — small delay lets Supabase finish token refresh first
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastVisibilityRefresh.current < 4 * 60 * 1000) return
      lastVisibilityRefresh.current = Date.now()
      setTimeout(() => fetchProjects(false), 800)
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchProjects, user?.id])

  // Real-time client-side status tick every 30s — no DB round-trip needed for UI updates
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setProjects(prev => {
        let changed = false
        const next = prev.map(p => {
          if (!p.mint_date || p.status === 'minted' || p.status === 'cancelled') return p
          const diffMs = now - new Date(p.mint_date)
          const diffHours = diffMs / (1000 * 60 * 60)
          const ns = diffMs < 0 ? 'upcoming' : diffHours < 2 ? 'live' : 'missed'
          if (ns !== p.status) { changed = true; return { ...p, status: ns } }
          return p
        })
        return changed ? next : prev
      })
    }
    tick() // run immediately on mount
    const interval = setInterval(tick, 30000)
    return () => clearInterval(interval)
  }, [])

  // Auto-check if any live mints need to fire (guard prevents double-trigger with Countdown)
  useEffect(() => {
    if (!hasAccess('pro')) return
    const autoProjects = projects.filter(p =>
      p.status === 'live' &&
      p.mint_mode === 'auto' &&
      p.automint_enabled !== false &&
      p.contract_address &&
      !p.auto_mint_fired  // skip if server-side cron already fired it
    )
    autoProjects.forEach(p => {
      if (!autoFired.current.has(p.id)) {
        autoFired.current.add(p.id)
        toast.success(`${p.name} is queued for Strike Mode. Alpha Vault safety checks will run before any transaction.`)
      }
    })
  }, [projects])

  // Load user's Telegram chat ID + auth token for notify calls
  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('telegram_chat_id').eq('id', user.id).single()
      .then(({ data }) => { if (data?.telegram_chat_id) setTelegramChatId(data.telegram_chat_id) })
    getAuthToken().then(token => { if (token) setUserToken(token) })
  }, [user])

  // Send Telegram live-alert when a project transitions to 'live'
  useEffect(() => {
    if (!telegramChatId || !userToken || !hasAccess('pro')) return
    projects.forEach(p => {
      if (p.status === 'live' && !tgNotified.current.has(p.id)) {
        tgNotified.current.add(p.id)
        try { sessionStorage.setItem('alphahub:tgNotified', JSON.stringify([...tgNotified.current])) } catch {}
        notifyTelegram({ ...p, _telegram_chat_id: telegramChatId }, 'live', userToken)
      }
    })
  }, [projects, telegramChatId, userToken])

  // Watch for Telegram mint approvals (user tapped "Confirm" in Telegram)
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('tg-mint-approvals')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'wl_projects',
        filter: `user_id=eq.${user.id}`,
      }, payload => {
        const updated = payload.new
        if (updated.telegram_mint_approved === true && updated.status !== 'minted') {
          supabase.from('wl_projects').update({ telegram_mint_approved: null }).eq('id', updated.id)
          setProjects(prev => prev.map(p => p.id === updated.id
            ? { ...p, ...updated, telegram_mint_approved: null } : p))
          if (updated.mint_mode === 'auto') {
            // Auto-mode projects execute via Alpha Vault on the server — the cron handles it.
            // Calling the wallet path here would block on a browser wallet prompt that never comes.
            toast.success(`${updated.name} — Strike Mode is armed, Alpha Vault will execute when ready.`)
            return
          }
          // Confirm-mode: skip the confirm modal, user already said yes in Telegram
          // Use ref so we always call the latest executeMint without stale closure
          executeMintRef.current?.({ ...updated })
        }
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [user])

  const filtered = activeTab === 'all' ? projects : projects.filter(p => p.status === activeTab)

  const handleAddProject = async (projectData) => {
    if (!user?.id) {
      toast.error('Not logged in — please sign out and back in')
      throw new Error('Not logged in')
    }
    if (projects.length >= limits.mintProjects) {
      setUpgradeRequired('More mint tracking requires Pro.')
      toast.error(`Your ${plan || 'Free'} plan tracks ${limits.mintProjects} mint project${limits.mintProjects === 1 ? '' : 's'}. Upgrade to add more.`)
      throw new Error('Plan limit reached')
    }
    // Map OpenSea-detected mint_status → DB status enum
    // DB uses: upcoming | live | minted | missed | cancelled
    const mintStatusDetected = projectData.mint_status || null
    const dbStatus =
      mintStatusDetected === 'live_now' ? 'live'
      : mintStatusDetected === 'ended'  ? 'missed'
      : 'upcoming'

    // Ensure mint_date is set for live mints — use current time so countdown shows LIVE NOW
    const mintDate =
      projectData.mint_date ||
      (mintStatusDetected === 'live_now' ? new Date().toISOString() : null)

    toast.loading('Saving...', { id: 'save-project' })
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Not authenticated — please sign in again')
      const response = await fetch('/api/calendar/save-mintguard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...projectData, mint_date: mintDate, mint_status: mintStatusDetected }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result?.ok === false) throw new Error(result?.error || `Save failed (${response.status})`)
      const data = result.project
      setProjects(prev => [data, ...prev])
      toast.success(`${data.name} added!`, { id: 'save-project' })
      setShowAddModal(false)
    } catch (err) {
      console.error('handleAddProject error:', err)
      toast.error(friendlyError(err, 'Could not save this project. Please try again.'), { id: 'save-project' })
      throw err
    }
  }

  const handleDelete = async (id) => {
    if (deletingId) return
    setDeletingId(id)
    const snapshot = projects.find(p => p.id === id)
    setProjects(prev => prev.filter(p => p.id !== id))
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before deleting this project.')
      const response = await fetch('/api/calendar/delete-mintguard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectId: id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.ok === false) throw new Error(data.error || 'Could not delete this project. Please try again.')
      toast.success(data.mode === 'archive' ? 'Project archived' : 'Project removed')
    } catch (error) {
      console.error('handleDelete project error:', error)
      if (snapshot) setProjects(prev => [snapshot, ...prev.filter(p => p.id !== id)])
      toast.error(friendlyError(error, 'Could not delete this project. Please try again.'))
    } finally {
      setDeletingId(null)
    }
  }

  const handleStatusUpdate = async (id, status) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, status } : p))
    const { error } = await supabase.from('wl_projects').update({ status }).eq('id', id)
    if (error) toast.error(friendlyError(error, 'Could not update this project. Please try again.'))
  }

  const handleEditProject = async (id, updates) => {
    try {
      toast.loading('Updating...', { id: 'edit-project' })
      await directUpdate('wl_projects', updates, 'id', id)
      setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p))
      toast.success('Project updated!', { id: 'edit-project' })
    } catch(e) {
      toast.error(friendlyError(e, 'Could not update this project. Please try again.'), { id: 'edit-project' })
    }
  }

  const handleMintModeToggle = async (project) => {
    if (!hasAccess('pro')) {
      setUpgradeRequired('Automint tools require Pro.')
      toast.error('Automint tools require Pro.')
      return
    }
    const id = project.id
    const currentMode = project.mint_mode
    const newMode = currentMode === 'confirm' ? 'auto' : 'confirm'
    if (newMode === 'auto') {
      // Open Strike Review modal instead of window.confirm
      // Load vault silently for the modal
      getAuthToken().then(token => {
        if (!token) return
        fetch('/api/vault/list', { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json()).then(d => setVaultWallet(d?.wallets?.[0] ?? null)).catch(() => {})
      })
      setStrikeReviewProject(project)
      return
    }
    // Disarming: flip back to confirm mode
    let { error } = await supabase
      .from('wl_projects')
      .update({ mint_mode: newMode, automint_enabled: false })
      .eq('id', id)
    if (error && String(error.message || '').includes('schema cache')) {
      const fallback = await supabase.from('wl_projects').update({ mint_mode: newMode }).eq('id', id)
      error = fallback.error
    }
    if (error) {
      toast.error(friendlyError(error, 'Could not update mint mode.'))
      return
    }
    setProjects(prev => prev.map(p => p.id === id ? { ...p, mint_mode: 'confirm', automint_enabled: false } : p))
    toast.success('Switched to Fast Mint')
  }

  const handleMint = async (project, isAuto = false) => {
    if (isAuto) {
      toast.success(`${project.name} is queued for Strike Mode server execution.`)
      return
    }
    if (!hasAccess('pro')) {
      setUpgradeRequired('Mint execution and automint tools require Pro.')
      toast.error('Mint execution requires Pro.')
      return
    }
    if (!isConnected) {
      toast.error('Connect your wallet first — use the Connect Wallet button in the header')
      return
    }
    if (!project.contract_address) {
      toast.error('No contract address set for this project')
      return
    }
    if (!isAuto && project.mint_mode === 'confirm') {
      setConfirmMint(project)
      return
    }
    executeMint(project)
  }

  // Called by StrikeReviewModal when user confirms arm
  const handleStrikeArm = async (project, opts = {}) => {
    const token = await getAuthToken()
    if (!token) throw new Error('Sign in again before enabling Strike Mode.')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let res, data
    try {
      res = await fetch('/api/mint/enable-strike', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          wlProjectId: project.id,
          name: project.name,
          contractAddress: project.contract_address,
          chain: project.chain,
          chainId: project.chain_id,
          quantity: project.max_mint || 1,
          mintPrice: project.mint_price || '0',
          maxTotalSpend: project.max_total_spend || '0.05',
          maxGasFee: project.max_gas_fee || null,
          mintDate: project.mint_date || new Date().toISOString(),
          // If mint_date is already in the past, arm with execute_at = now so the worker
          // fires immediately instead of expiring (sweep kills intents where execute_at
          // is > 5 min old before fetchReadyIntents even claims them).
          strikeExecuteAt: (project.mint_date && new Date(project.mint_date).getTime() > Date.now())
            ? project.mint_date
            : new Date().toISOString(),
          acknowledgeRisk: true,
          simulationOnly: opts.simulationOnly ?? true,
          gasStrategy: opts.gasStrategy || 'balanced',
        }),
      })
      data = await res.json().catch(() => ({}))
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'Strike arm timed out — try again.' : err.message)
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not arm Strike Mode.')

    // Update wl_projects mode in DB
    let { error } = await supabase
      .from('wl_projects')
      .update({ mint_mode: 'auto', automint_enabled: true })
      .eq('id', project.id)
    if (error && String(error.message || '').includes('schema cache')) {
      const fallback = await supabase.from('wl_projects').update({ mint_mode: 'auto' }).eq('id', project.id)
      if (fallback.error) throw new Error(friendlyError(fallback.error, 'Could not save Strike Mode setting.'))
    } else if (error) {
      throw new Error(friendlyError(error, 'Could not save Strike Mode setting.'))
    }

    setProjects(prev => prev.map(p =>
      p.id === project.id ? { ...p, mint_mode: 'auto', automint_enabled: true } : p,
    ))
    setStrikeReviewProject(null)
    const msg = data.dryRun
      ? (data.message || 'Strike armed (dry run — LIVE_EXECUTION_ENABLED is off).')
      : (data.message || (opts.simulationOnly ? 'Strike armed in simulation mode.' : 'Strike armed. Worker is watching.'))
    toast.success(msg)
  }

  const handleOpenReplay = async (project) => {
    setReplayProject(project)
    setReplayIntentId(null)
    // Fetch latest intent for this project
    const { data } = await supabase
      .from('mint_intents')
      .select('id, status')
      .eq('user_id', user.id)
      .eq('wl_project_id', project.id)
      .order('updated_at', { ascending: false })
      .limit(1)
    setReplayIntentId(data?.[0]?.id ?? null)
  }

  const executeMint = async (project) => {
    setMintingId(project.id)
    // Snapshot token/chatId at execution time — avoids stale closure issues
    const liveToken = await getAuthToken() || userToken
    const { data: profileData } = await supabase.from('profiles').select('telegram_chat_id').eq('id', user.id).single()
    const liveChatId = profileData?.telegram_chat_id || telegramChatId
    const tgProject = { ...project, _telegram_chat_id: liveChatId }

    // Mark as fired in DB before attempting — prevents cron from double-firing same project
    if (project.mint_mode === 'auto') {
      await supabase.from('wl_projects').update({ auto_mint_fired: true }).eq('id', project.id)
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, auto_mint_fired: true } : p))
    }

    // Notify Telegram that auto-mint is firing
    if (liveChatId && project.mint_mode === 'auto') {
      notifyTelegram(tgProject, 'auto', liveToken)
    }
    setMintErrors(prev => { const n = { ...prev }; delete n[project.id]; return n })
    try {
      const result = await mintHook(project, user.id)
      if (result?.success) {
        setMintErrors(prev => { const n = { ...prev }; delete n[project.id]; return n })
        await supabase.from('wl_projects').update({ status: 'minted' }).eq('id', project.id)
        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: 'minted' } : p))
        await supabase.from('notifications').insert({
          user_id: user.id,
          type: 'mint_success',
          title: `✅ Mint Success -- ${project.name}`,
          message: `Transaction confirmed. Hash: ${result.txHash?.slice(0, 16)}...`,
          data: { tx_hash: result.txHash, project_id: project.id },
        })
        // Telegram success alert
        notifyTelegram({ ...tgProject, tx_hash: result.txHash }, 'success', liveToken)
      } else if (result && !result.success) {
        setMintErrors(prev => ({ ...prev, [project.id]: { text: result.error, fault: result.fault || 'app' } }))
        await supabase.from('notifications').insert({
          user_id: user.id,
          type: 'mint_failed',
          title: `❌ Mint Failed -- ${project.name}`,
          message: result.error,
          data: { project_id: project.id },
        })
        // Reset auto_mint_fired so user can retry
        if (project.mint_mode === 'auto') {
          await supabase.from('wl_projects').update({ auto_mint_fired: false }).eq('id', project.id)
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, auto_mint_fired: false } : p))
          autoFired.current.delete(project.id)
        }
        // Telegram failure alert
        notifyTelegram({ ...tgProject, error: result.error }, 'failed', liveToken)
        // Hint to fix contract address if function detection failed
        if (/not found|check contract|no function/i.test(result.error || '')) {
          toast('Update contract address in Edit', { id: 'mint-edit-hint', duration: 6000, icon: '✏️' })
        }
      }
    } finally {
      setMintingId(null)
      setConfirmMint(null)
    }
  }

  // Keep ref current so the realtime subscription callback always calls the latest executeMint
  React.useEffect(() => { executeMintRef.current = executeMint })

  const liveCount = projects.filter(p => p.status === 'live').length
  const upcomingCount = projects.filter(p => p.status === 'upcoming').length

  if (upgradeRequired) {
    return (
      <Paywall
        onSuccess={refresh}
        showBack
        requiredPlan="pro"
        currentPlan={plan || 'free'}
        lockMessage={upgradeRequired}
      />
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="hero-panel mb-6">
        <div className="hero-content flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="mascot-orb"><Shield size={17} /></span>
              <span className="badge badge-cyan">My Mints</span>
              {liveCount > 0 && (
                <span className="badge badge-green animate-pulse-slow">{liveCount} live now</span>
              )}
            </div>
            <h1 className="text-3xl font-black tracking-tight">Track launches without the chaos.</h1>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              Save mints, confirm launch times, get alerts, and let Alpha Hub prepare the transaction. Safe Mint and Fast Mint keep you in control by default.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="filter-chip active"><Wand2 size={13} /> Fast Mint</span>
              <span className="filter-chip">Strike opt-in</span>
              <span className="filter-chip">Spend limits</span>
              <span className="filter-chip">
                {plan === 'admin'
                  ? 'Admin Mode'
                  : plan === 'free' || !plan
                  ? `${projects.length}/${limits.mintProjects} free tracks`
                  : `${projects.length}/${limits.mintProjects} ${plan?.toUpperCase()} tracks`}
              </span>
            </div>
          </div>
          <button
            onClick={async () => {
              if (!user) { toast.error('Please sign out and back in, then try again.'); return }
              console.debug('[import] starting')

              // Auto-import from clipboard before opening modal
              let clipUrl = null
              try {
                const clip = (await navigator.clipboard.readText())?.trim()
                if (clip && /^https?:\/\//i.test(clip)) clipUrl = clip
              } catch {}

              if (clipUrl) {
                setPageImportLoading(true)
                toast.loading('Fetching project data...', { id: 'import-meta' })
                console.debug('[import] fetching OpenSea:', clipUrl)
                try {
                  const resp = await fetch(
                    `/api/metadata?url=${encodeURIComponent(clipUrl)}`,
                    { signal: AbortSignal.timeout(12000) }
                  )
                  const data = await resp.json()
                  console.debug('[import] scraper result:', data)
                  setPendingImportData({ url: clipUrl, meta: data, failed: false })
                } catch (err) {
                  console.debug('[import] fallback triggered:', err?.message || err)
                  setPendingImportData({ url: clipUrl, meta: null, failed: true })
                } finally {
                  setPageImportLoading(false)
                  toast.dismiss('import-meta')
                }
              } else {
                // No clipboard URL -- open at step 1 for manual entry
                setPendingImportData(null)
              }

              setShowAddModal(true)
            }}
            disabled={pageImportLoading}
            className="btn-primary flex items-center justify-center gap-2 min-w-[110px]"
          >
            {pageImportLoading
              ? <Loader size={15} className="animate-spin" />
              : <><Plus size={15} /> Add Alpha</>}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Projects', val: projects.length, color: 'text-text' },
          { label: 'Upcoming', val: upcomingCount, color: 'text-accent3' },
          { label: 'Live Now', val: liveCount, color: 'text-green' },
          { label: 'Minted', val: projects.filter(p => p.status === 'minted').length, color: 'text-accent' },
        ].map(s => (
          <div key={s.label} className="metric-card">
            <div className={`text-2xl font-bold ${s.color}`}>{s.val}</div>
            <div className="section-label mt-1 mb-0">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 mb-4 overflow-x-auto">
        {STATUS_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 min-w-fit py-2 px-3 text-xs font-mono uppercase tracking-wider rounded-md transition-all ${
              activeTab === tab ? 'bg-surface2 text-accent border border-border2' : 'text-muted hover:text-text'
            }`}
          >
            {tab}
            {tab !== 'all' && (
              <span className="ml-1.5 opacity-60">{projects.filter(p => p.status === tab).length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Projects list */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="alpha-loader" />
          <p className="mt-4 text-sm text-muted">Preparing your mint radar...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Sparkles size={32} className="text-accent mb-3" />
          <h2 className="text-lg font-bold">No mints saved yet</h2>
          <p className="text-muted text-sm mt-2 max-w-md">Add a mint link, contract, or project name. Alpha Hub will help detect timing and keep it in Safe Mint until you decide otherwise.</p>
          <button onClick={() => setShowAddModal(true)} className="btn-ghost mt-4 text-xs">
            Add your first alpha
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {filtered.map(project => (
              <div key={project.id}>
                <ProjectCard
                  project={project}
                  isMinting={mintingId === project.id}
                  isDeleting={deletingId === project.id}
                  onMint={(isAuto) => handleMint(project, isAuto)}
                  onDelete={() => handleDelete(project.id)}
                  onStatusUpdate={(s) => handleStatusUpdate(project.id, s)}
                  onMintModeToggle={() => handleMintModeToggle(project)}
                  onEdit={(updates) => handleEditProject(project.id, updates)}
                  onReplay={() => handleOpenReplay(project)}
                />
                {mintErrors[project.id] && (
                  <div className={`mx-1 -mt-1 rounded-b-xl px-4 py-2.5 flex items-start gap-2.5 text-sm border-t ${
                    mintErrors[project.id].fault === 'collection'
                      ? 'bg-amber-950/60 border-amber-800/40 text-amber-200'
                      : mintErrors[project.id].fault === 'wallet'
                      ? 'bg-orange-950/60 border-orange-800/40 text-orange-200'
                      : 'bg-red-950/60 border-red-800/40 text-red-200'
                  }`}>
                    <span className="mt-0.5 shrink-0 text-base">
                      {mintErrors[project.id].fault === 'collection' ? '📋' : mintErrors[project.id].fault === 'wallet' ? '👛' : '⚠️'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold mr-1">
                        {mintErrors[project.id].fault === 'collection' ? 'Collection issue:' : mintErrors[project.id].fault === 'wallet' ? 'Wallet issue:' : 'App error:'}
                      </span>
                      {mintErrors[project.id].text}
                      {mintErrors[project.id].fault === 'collection' && (project.source_url || project.mint_url || project.website_url) && (
                        <a
                          href={project.source_url || project.mint_url || project.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 inline-flex items-center gap-1 underline opacity-80 hover:opacity-100 whitespace-nowrap"
                        >
                          Open official mint <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                    <button
                      onClick={() => setMintErrors(prev => { const n = { ...prev }; delete n[project.id]; return n })}
                      className="shrink-0 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
                    >×</button>
                  </div>
                )}
              </div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Modals - direct render without AnimatePresence for reliability */}
      {showAddModal && (
        <AddProjectModal
          onAdd={handleAddProject}
          onClose={() => {
            setShowAddModal(false)
            setInitialContract(null)
            setInitialChain('eth')
            setPendingImportData(null)
          }}
          initialValues={initialContract ? { contract_address: initialContract, chain: initialChain } : {}}
          pendingImportData={pendingImportData}
        />
      )}
      {confirmMint && (
        <MintConfirmModal
          project={confirmMint}
          onConfirm={(gasOverride) => executeMint({ ...confirmMint, gas_limit: gasOverride })}
          onCancel={() => setConfirmMint(null)}
        />
      )}
      {strikeReviewProject && (
        <StrikeReviewModal
          project={strikeReviewProject}
          vault={vaultWallet}
          onConfirmArm={handleStrikeArm}
          onClose={() => setStrikeReviewProject(null)}
        />
      )}
      {replayProject && (
        <StrikeReplayModal
          project={replayProject}
          intentId={replayIntentId}
          onClose={() => { setReplayProject(null); setReplayIntentId(null) }}
          onRerun={() => {
            setProjects(prev => prev.map(p =>
              p.id === replayProject.id ? { ...p, mint_mode: 'auto', automint_enabled: true } : p,
            ))
          }}
        />
      )}
    </div>
  )
}
