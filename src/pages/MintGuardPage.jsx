import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Shield } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase, directInsert, directUpdate, getAuthToken } from '../lib/supabase'
import { useMint } from '../hooks/useMint'
import { useAuthStore } from '../store'
import AddProjectModal from '../components/mint/AddProjectModal'
import MintConfirmModal from '../components/mint/MintConfirmModal'
import ProjectCard from '../components/mint/ProjectCard'

const STATUS_TABS = ['all', 'upcoming', 'live', 'minted', 'missed']

// Send a notification to the user's Telegram (fire-and-forget)
async function notifyTelegram(project, type, userToken) {
  const chatId = project._telegram_chat_id
  if (!chatId || !userToken) return
  try {
    await fetch('/api/telegram-notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + userToken,
      },
      body: JSON.stringify({ chat_id: chatId, project, type }),
    })
  } catch {}
}

export default function MintGuardPage() {
  const { user } = useAuthStore()
  const { executeMint: mintHook, isConnected } = useMint()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [showAddModal, setShowAddModal] = useState(false)
  const [confirmMint, setConfirmMint] = useState(null) // project to confirm mint for
  const [mintingId, setMintingId] = useState(null)
  const [telegramChatId, setTelegramChatId] = useState(null)
  const [userToken, setUserToken] = useState(null)
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
      const { data, error } = await supabase
        .from('wl_projects')
        .select('*')
        .eq('user_id', user.id)
        .order('mint_date', { ascending: true, nullsFirst: false })
      if (error) { console.error('fetchProjects error:', error); return }
      // Never overwrite existing projects with an empty result — could be a transient
      // auth token refresh causing RLS to block the query momentarily.
      if (data && data.length > 0) {
        const updated = await autoUpdateStatus(data)
        setProjects(updated)
      } else if (data && data.length === 0) {
        // Only clear if we genuinely have nothing on first load
        setProjects(prev => prev.length === 0 ? [] : prev)
      }
    } catch(e) {
      console.error('fetchProjects catch:', e)
    } finally {
      setLoading(false)
    }
  }, [user])

  // First load with spinner, subsequent interval refreshes silent
  const initialLoad = React.useRef(false)

  useEffect(() => {
    if (!initialLoad.current) {
      initialLoad.current = true
      fetchProjects(true) // show spinner on first load
    }
    // Silent background refresh every 60s -- never clears projects
    const interval = setInterval(() => fetchProjects(false), 60000)

    // Re-fetch when tab/app becomes visible — small delay lets Supabase finish token refresh first
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setTimeout(() => fetchProjects(false), 800)
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
    const autoProjects = projects.filter(p =>
      p.status === 'live' &&
      p.mint_mode === 'auto' &&
      p.contract_address &&
      !p.auto_mint_fired  // skip if server-side cron already fired it
    )
    autoProjects.forEach(p => {
      if (!autoFired.current.has(p.id)) {
        autoFired.current.add(p.id)
        handleMint(p, true)
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
    if (!telegramChatId || !userToken) return
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
      max_mint: projectData.max_mint || 1,
      gas_limit: projectData.gas_limit || 200000,
      notes: projectData.notes || null,
      user_id: user.id,
      status: 'upcoming',
    }
    toast.loading('Saving...', { id: 'save-project' })
    try {
      const data = await directInsert('wl_projects', insertData)
      setProjects(prev => [data, ...prev])
      toast.success(`${data.name} added!`, { id: 'save-project' })
      setShowAddModal(false)
    } catch (err) {
      console.error('handleAddProject error:', err)
      toast.error(err.message || 'Save failed', { id: 'save-project' })
      throw err
    }
  }

  const handleDelete = async (id) => {
    const snapshot = projects.find(p => p.id === id)
    setProjects(prev => prev.filter(p => p.id !== id))
    const { error } = await supabase.from('wl_projects').delete().eq('id', id)
    if (error) {
      if (snapshot) setProjects(prev => [snapshot, ...prev.filter(p => p.id !== id)])
      toast.error('Delete failed: ' + error.message)
      return
    }
    toast.success('Project removed')
  }

  const handleStatusUpdate = async (id, status) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, status } : p))
    const { error } = await supabase.from('wl_projects').update({ status }).eq('id', id)
    if (error) toast.error('Status update failed: ' + error.message)
  }

  const handleEditProject = async (id, updates) => {
    try {
      toast.loading('Updating...', { id: 'edit-project' })
      await directUpdate('wl_projects', updates, 'id', id)
      setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p))
      toast.success('Project updated!', { id: 'edit-project' })
    } catch(e) {
      toast.error(e.message, { id: 'edit-project' })
    }
  }

  const handleMintModeToggle = async (id, currentMode) => {
    const newMode = currentMode === 'confirm' ? 'auto' : 'confirm'
    await supabase.from('wl_projects').update({ mint_mode: newMode }).eq('id', id)
    setProjects(prev => prev.map(p => p.id === id ? { ...p, mint_mode: newMode } : p))
    toast.success(`Switched to ${newMode === 'auto' ? '⚡ Auto-Mint' : '✓ Confirm-Mint'}`)
  }

  const handleMint = async (project, isAuto = false) => {
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

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield size={20} className="text-accent" />
            <h1 className="text-xl font-bold">MintGuard</h1>
            {liveCount > 0 && (
              <span className="badge badge-green animate-pulse-slow">{liveCount} LIVE</span>
            )}
          </div>
          <p className="text-sm text-muted">Track your WL projects. Get alerted. Auto-mint when ready.</p>
        </div>
        <button onClick={() => {
          if (!user) { toast.error('Not authenticated - please sign out and back in'); return }
          setShowAddModal(true)
        }} className="btn-primary flex items-center gap-2">
          <Plus size={15} />
          Add Project
        </button>
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
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <Shield size={32} className="text-muted mb-3" />
          <p className="text-muted text-sm">No projects here yet</p>
          <button onClick={() => setShowAddModal(true)} className="btn-ghost mt-4 text-xs">
            + Add your first WL project
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
