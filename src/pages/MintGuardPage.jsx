import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Shield, Sparkles, Wand2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase, directInsert, directUpdate, getAuthToken } from '../lib/supabase'
import { useMint } from '../hooks/useMint'
import { useSubscription } from '../hooks/useSubscription'
import { useAuthStore } from '../store'
import { friendlyError } from '../lib/errors'
import Paywall from '../components/Paywall'
import AddProjectModal from '../components/mint/AddProjectModal'
import MintConfirmModal from '../components/mint/MintConfirmModal'
import ProjectCard from '../components/mint/ProjectCard'

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
  const { user } = useAuthStore()
  const { plan, limits, hasAccess, refresh } = useSubscription()
  const { executeMint: mintHook, isConnected } = useMint()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [showAddModal, setShowAddModal] = useState(false)
  const [confirmMint, setConfirmMint] = useState(null) // project to confirm mint for
  const [mintingId, setMintingId] = useState(null)
  const [telegramChatId, setTelegramChatId] = useState(null)
  const [userToken, setUserToken] = useState(null)
  const [upgradeRequired, setUpgradeRequired] = useState(null)
  const autoFired = React.useRef(new Set())
  const tgNotified = React.useRef(new Set()) // prevent duplicate Telegram notifications

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
        .order('mint_date', { ascending: true, nullsFirst: false })
      const { data, error } = await query
      if (error) { console.error('fetchProjects error:', error); return }
      if (Array.isArray(data)) {
        const updated = await autoUpdateStatus(data)
        setProjects(updated)
      }
    } catch(e) {
      console.error('fetchProjects catch:', e)
    } finally {
      setLoading(false)
    }
  }, [user])

  // First load with spinner, subsequent interval refreshes silent
  const initialLoad = React.useRef(false)
  const lastVisibilityRefresh = React.useRef(0)

  useEffect(() => {
    setProjects([])
    setLoading(true)
    initialLoad.current = false
    if (!initialLoad.current) {
      initialLoad.current = true
      fetchProjects(true) // show spinner on first load
    }
    // Silent background refresh every 60s -- never clears projects
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
  }, [fetchProjects])

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
        toast.success(`${p.name} is queued for Auto Beta. Server safety checks will run before any transaction.`)
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
          // Reset the flag first, then execute
          supabase.from('wl_projects').update({ telegram_mint_approved: null }).eq('id', updated.id)
          setProjects(prev => prev.map(p => p.id === updated.id
            ? { ...p, ...updated, telegram_mint_approved: null } : p))
          // Execute the mint directly (skip confirm modal — user already confirmed in Telegram)
          executeMint({ ...updated })
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
    const insertData = {
      name: projectData.name || 'Unnamed',
      source_url: projectData.source_url || null,
      source_type: projectData.source_type || 'website',
      chain: projectData.chain || 'eth',
      contract_address: projectData.contract_address || null,
      mint_date: projectData.mint_date || null,
      mint_price: projectData.mint_price || null,
      wl_type: projectData.wl_type || 'UNKNOWN',
      mint_mode: projectData.mint_mode || 'confirm',
      automint_enabled: projectData.automint_enabled ?? false,
      max_mint: projectData.max_mint || 1,
      gas_limit: projectData.gas_limit || 200000,
      max_mint_price: projectData.max_mint_price || null,
      max_gas_fee: projectData.max_gas_fee || null,
      max_total_spend: projectData.max_total_spend || null,
      mint_time_source: projectData.mint_time_source || null,
      mint_time_confidence: projectData.mint_time_confidence || null,
      mint_time_confirmed: projectData.mint_time_confirmed ?? Boolean(projectData.mint_date),
      mint_time_confirmed_at: projectData.mint_time_confirmed_at || null,
      execution_status: 'queued',
      notes: projectData.notes || null,
      user_id: user.id,
      status: 'upcoming',
    }
    toast.loading('Saving...', { id: 'save-project' })
    try {
      let data
      try {
        data = await directInsert('wl_projects', insertData)
      } catch (schemaError) {
        if (!String(schemaError.message || '').includes('schema cache')) throw schemaError
        const fallbackData = { ...insertData }
        OPTIONAL_PROJECT_FIELDS.forEach((field) => delete fallbackData[field])
        data = await directInsert('wl_projects', fallbackData)
        console.warn('Saved project without optional automint safety columns. Apply the automint schema migration before launch.')
      }
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
    const snapshot = projects.find(p => p.id === id)
    setProjects(prev => prev.filter(p => p.id !== id))
    const { error } = await supabase.from('wl_projects').delete().eq('id', id)
    if (error) {
      if (snapshot) setProjects(prev => [snapshot, ...prev.filter(p => p.id !== id)])
      toast.error(friendlyError(error, 'Could not delete this project. Please try again.'))
      return
    }
    toast.success('Project removed')
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

  const handleMintModeToggle = async (id, currentMode) => {
    if (!hasAccess('pro')) {
      setUpgradeRequired('Automint tools require Pro.')
      toast.error('Automint tools require Pro.')
      return
    }
    const newMode = currentMode === 'confirm' ? 'auto' : 'confirm'
    if (newMode === 'auto') {
      const accepted = window.confirm('Auto Beta can execute real blockchain transactions from your configured wallet. Use an isolated wallet and set max spend limits. Continue?')
      if (!accepted) return
    }
    let { error } = await supabase
      .from('wl_projects')
      .update({ mint_mode: newMode, automint_enabled: newMode === 'auto' })
      .eq('id', id)
    if (error && String(error.message || '').includes('schema cache')) {
      const fallback = await supabase.from('wl_projects').update({ mint_mode: newMode }).eq('id', id)
      error = fallback.error
    }
    if (error) {
      toast.error(friendlyError(error, 'Could not update mint mode.'))
      return
    }
    setProjects(prev => prev.map(p => p.id === id ? { ...p, mint_mode: newMode, automint_enabled: newMode === 'auto' } : p))
    toast.success(`Switched to ${newMode === 'auto' ? '⚡ Auto Beta' : '✓ Confirm Mode'}`)
  }

  const handleMint = async (project, isAuto = false) => {
    if (isAuto) {
      toast.success(`${project.name} is queued for Auto Beta server execution.`)
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
    try {
      const result = await mintHook(project, user.id)
      if (result?.success) {
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
      }
    } finally {
      setMintingId(null)
      setConfirmMint(null)
    }
  }

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
              Save mints, confirm launch times, get alerts, and let Alpha Hub prepare the transaction. You stay in control with Confirm Mode by default.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="filter-chip active"><Wand2 size={13} /> Confirm Mode</span>
              <span className="filter-chip">Auto Beta opt-in</span>
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
          <button onClick={() => {
            if (!user) { toast.error('Please sign out and back in, then try again.'); return }
            setShowAddModal(true)
          }} className="btn-primary flex items-center justify-center gap-2">
            <Plus size={15} />
            Add Alpha
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
        <div className="flex items-center justify-center py-16">
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Sparkles size={32} className="text-accent mb-3" />
          <h2 className="text-lg font-bold">No mints saved yet</h2>
          <p className="text-muted text-sm mt-2 max-w-md">Add a mint link, contract, or project name. Alpha Hub will help detect timing and keep it in Confirm Mode until you decide otherwise.</p>
          <button onClick={() => setShowAddModal(true)} className="btn-ghost mt-4 text-xs">
            Add your first alpha
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {filtered.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                isMinting={mintingId === project.id}
                onMint={(isAuto) => handleMint(project, isAuto)}
                onDelete={() => handleDelete(project.id)}
                onStatusUpdate={(s) => handleStatusUpdate(project.id, s)}
                onMintModeToggle={() => handleMintModeToggle(project.id, project.mint_mode)}
                onEdit={(updates) => handleEditProject(project.id, updates)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Modals - direct render without AnimatePresence for reliability */}
      {showAddModal && (
        <AddProjectModal
          onAdd={handleAddProject}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {confirmMint && (
        <MintConfirmModal
          project={confirmMint}
          onConfirm={(gasOverride) => executeMint({ ...confirmMint, gas_limit: gasOverride })}
          onCancel={() => setConfirmMint(null)}
        />
      )}
    </div>
  )
}
