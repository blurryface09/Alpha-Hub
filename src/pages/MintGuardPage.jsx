import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Shield, Clock, Zap, AlertTriangle, Check, X, ExternalLink, ChevronDown, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase, directInsert, directUpdate, withTimeout } from '../lib/supabase'
import { useMint } from '../hooks/useMint'
import { useAuthStore } from '../store'
import { buildMintTransaction, CHAINS } from '../lib/blockchain'
import AddProjectModal from '../components/mint/AddProjectModal'
import MintConfirmModal from '../components/mint/MintConfirmModal'
import ProjectCard from '../components/mint/ProjectCard'

const STATUS_TABS = ['all', 'upcoming', 'live', 'minted', 'missed']

export default function MintGuardPage() {
  const { user } = useAuthStore()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [showAddModal, setShowAddModal] = useState(false)
  const [confirmMint, setConfirmMint] = useState(null) // project to confirm mint for
  const [mintingId, setMintingId] = useState(null)

  const fetchProjects = useCallback(async (showLoader = false) => {
    if (!user) { setLoading(false); return }
    try {
      // Only show loading spinner on first load, not on interval refreshes
      if (showLoader) setLoading(true)
      const { data, error } = await supabase
        .from('wl_projects')
        .select('*')
        .eq('user_id', user.id)
        .order('mint_date', { ascending: true, nullsFirst: false })
      if (error) { console.error('fetchProjects error:', error); return }
      // Only update if we actually got data -- never clear existing projects on error
      if (data) setProjects(data)
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
    return () => clearInterval(interval)
  }, [fetchProjects])

  // Auto-check if any live mints need to fire
  useEffect(() => {
    const autoProjects = projects.filter(p => p.status === 'live' && p.mint_mode === 'auto')
    autoProjects.forEach(p => {
      if (p.contract_address) handleMint(p, true)
    })
  }, [projects])

  const filtered = activeTab === 'all' ? projects : projects.filter(p => p.status === activeTab)

  const handleAddProject = async (projectData) => {
    try {
      if (!user?.id) { toast.error('Not logged in -- please sign out and back in'); return }
      const insertData = {
        name: projectData.name || 'Unnamed',
        source_url: projectData.source_url || 'https://unknown.com',
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
      const data = await directInsert('wl_projects', insertData)
      setProjects(prev => [data, ...prev])
      toast.success(`${data.name} added!`, { id: 'save-project' })
      setShowAddModal(false)
    } catch (err) {
      console.error('Unexpected error:', err)
      toast.error(`Unexpected error: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    await supabase.from('wl_projects').delete().eq('id', id)
    setProjects(prev => prev.filter(p => p.id !== id))
    toast.success('Project removed')
  }

  const handleStatusUpdate = async (id, status) => {
    await supabase.from('wl_projects').update({ status }).eq('id', id)
    setProjects(prev => prev.map(p => p.id === id ? { ...p, status } : p))
  }

  const handleEditProject = async (id, updates) => {
    try {
      toast.loading('Updating...', { id: 'edit-project' })
      const data = await directUpdate('wl_projects', updates, 'id', id)
      setProjects(prev => prev.map(p => p.id === id ? { ...p, ...data } : p))
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
    try {
      // Check if wallet is connected via wagmi
      const { getAccount, writeContract } = await import('@wagmi/core')
      const account = getAccount()
      if (!account.address) {
        toast.error('Connect your wallet first in Settings')
        return
      }

      const chainKey = project.chain || 'eth'
      const mintData = await buildMintTransaction({
        contractAddress: project.contract_address,
        chainKey,
        maxMint: project.max_mint || 1,
        gasLimit: project.gas_limit || 200000,
      })

      // Find mint function from ABI
      const mintFn = mintData.abi?.find(fn => fn.name?.toLowerCase().includes('mint') && fn.type === 'function')
      if (!mintFn) throw new Error('Could not find mint function in contract ABI')

      toast.loading(`Executing mint on ${CHAINS[chainKey].name}...`, { id: 'mint' })

      const hash = await writeContract({
        address: project.contract_address,
        abi: mintData.abi,
        functionName: mintFn.name,
        args: mintFn.inputs?.length > 0 ? [project.max_mint || 1] : [],
        gas: BigInt(project.gas_limit || 200000),
      })

      // Log to Supabase
      await supabase.from('mint_log').insert({
        user_id: user.id,
        project_id: project.id,
        wallet_address: account.address,
        chain: chainKey,
        tx_hash: hash,
        status: 'success',
      })

      await supabase.from('wl_projects').update({ status: 'minted' }).eq('id', project.id)
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: 'minted' } : p))

      toast.success(`Mint executed! TX: ${hash.slice(0, 12)}...`, { id: 'mint', duration: 8000 })

      // Create notification
      await supabase.from('notifications').insert({
        user_id: user.id,
        type: 'mint_success',
        title: `✅ Mint Success -- ${project.name}`,
        message: `Transaction confirmed. Hash: ${hash.slice(0, 16)}...`,
        data: { tx_hash: hash, project_id: project.id },
      })

    } catch (err) {
      toast.error(`Mint failed: ${err.message}`, { id: 'mint' })
      await supabase.from('mint_log').insert({
        user_id: user.id,
        project_id: project.id,
        wallet_address: 'unknown',
        chain: project.chain || 'eth',
        status: 'failed',
        error_message: err.message,
      })
      await supabase.from('notifications').insert({
        user_id: user.id,
        type: 'mint_failed',
        title: `❌ Mint Failed -- ${project.name}`,
        message: err.message,
        data: { project_id: project.id },
      })
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
                onMint={() => handleMint(project)}
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
          onConfirm={() => executeMint(confirmMint)}
          onCancel={() => setConfirmMint(null)}
        />
      )}
    </div>
  )
}
