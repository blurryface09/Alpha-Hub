import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarDays, Clock, ExternalLink, Gem, Loader, Plus, Radar,
  Search, Shield, Sparkles, TrendingUp, Zap
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useAccount } from 'wagmi'
import { supabase, getAuthToken } from '../lib/supabase'
import { useAuthStore } from '../store'
import { useSubscription } from '../hooks/useSubscription'
import { friendlyError } from '../lib/errors'
import {
  isActiveMintCalendarProject,
  isLaunchReadyCalendarProject,
  isRawCalendarDiscovery,
  mintGuardEligible,
} from '../lib/calendarQuality'

const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()

const TABS = [
  { id: 'trending', label: 'Trending', icon: TrendingUp, copy: 'Highest visible activity and strongest tracked-wallet signals.' },
  { id: 'hidden-gems', label: 'Hidden Gems', icon: Gem, copy: 'Low-noise mints with early contract, whale, or deployer signals.' },
  { id: 'minting-now', label: 'Minting Now', icon: Zap, copy: 'Live launches, warm countdowns, and mints that need fast review.' },
  { id: 'new-contracts', label: 'New Contracts', icon: Shield, copy: 'Fresh ERC721/ERC1155-style contracts that need intelligence review.' },
]

const CHAINS = [
  { value: 'eth', label: 'Ethereum', chainId: 1 },
  { value: 'base', label: 'Base', chainId: 8453 },
  { value: 'bnb', label: 'BNB Chain', chainId: 56 },
]

function normalizeChain(chain) {
  const value = String(chain || 'eth').toLowerCase()
  if (value.includes('base')) return 'base'
  if (value.includes('bnb') || value.includes('bsc')) return 'bnb'
  return 'eth'
}

function chainIdFor(chain) {
  return CHAINS.find(item => item.value === normalizeChain(chain))?.chainId || 1
}

function scoreFor(project, tab) {
  if (tab === 'hidden-gems') return project.hidden_gem_score || 0
  if (tab === 'new-contracts') return project.first_seen_at ? new Date(project.first_seen_at).getTime() : 0
  if (tab === 'minting-now') return project.mint_count || project.hype_score || 0
  return project.hype_score || project.whale_interest_score || 0
}

function isLive(project) {
  if (project.status === 'live') return true
  if (!project.mint_date) return false
  const date = new Date(project.mint_date).getTime()
  const now = Date.now()
  return date <= now && date > now - 12 * 60 * 60 * 1000
}

function tabFilter(project, tab) {
  const raw = isRawCalendarDiscovery(project)
  if (tab === 'new-contracts') return raw || project.status === 'pending_review' || !project.mint_date
  if (tab === 'minting-now') return isActiveMintCalendarProject(project)
  if (!isLaunchReadyCalendarProject(project)) return false
  if (tab === 'hidden-gems') return (project.hidden_gem_score || 0) >= (project.hype_score || 0) || (project.hype_score || 0) < 45
  return true
}

function countdown(project) {
  if (!project.mint_date) return 'Time needs review'
  const diff = new Date(project.mint_date).getTime() - Date.now()
  if (diff <= 0) return 'LIVE NOW'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function formatTime(project) {
  if (!project.mint_date) return 'Mint time not confirmed'
  const date = new Date(project.mint_date)
  return `${date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} local / ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function confidenceClass(confidence) {
  if (confidence === 'high') return 'badge-green'
  if (confidence === 'medium') return 'badge-yellow'
  return 'badge-red'
}

function sourceLabel(source) {
  if (!source) return 'Community'
  return source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function shortAddress(address) {
  if (!address) return null
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function projectTitle(project) {
  const name = String(project.name || '').trim()
  if (name && !isRawCalendarDiscovery({ ...project, name })) return name
  if (project.contract_address) return `NFT Contract ${shortAddress(project.contract_address)}`
  return 'Untitled Mint Project'
}

function projectSummary(project) {
  if (project.description) return project.description
  if (project.source === 'onchain') {
    return 'Live mint activity was detected onchain. Add official links or inspect details before tracking.'
  }
  return 'Sourced mint opportunity. Confirm official details before arming Auto Beta.'
}

function confidenceText(project) {
  const confidence = project.source_confidence || project.mint_date_confidence || 'low'
  if (confidence === 'high') return 'High'
  if (confidence === 'medium') return 'Medium'
  return 'Needs review'
}

function timeAgo(value) {
  if (!value) return 'never'
  const diff = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diff)) return 'unknown'
  const mins = Math.max(0, Math.floor(diff / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function CalendarPage() {
  const { user } = useAuthStore()
  const { address, isConnected } = useAccount()
  const { plan } = useSubscription()
  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_WALLET
  const [activeTab, setActiveTab] = useState('trending')
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [schemaMissing, setSchemaMissing] = useState(false)
  const [status, setStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedProject, setSelectedProject] = useState(null)
  const [query, setQuery] = useState('')
  const [chain, setChain] = useState('all')
  const [form, setForm] = useState({
    name: '',
    chain: 'base',
    mint_date: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    mint_price: '',
    mint_type: 'unknown',
    website_url: '',
    x_url: '',
    discord_url: '',
    mint_url: '',
    contract_address: '',
    image_url: '',
    notes: '',
  })
  const calendarNotReady = schemaMissing || status?.schemaMissing

  const fetchProjects = useCallback(async () => {
    setLoading(true)
    try {
      let request = supabase
        .from('calendar_projects')
        .select('*')
        .in('status', isAdmin ? ['pending_review', 'approved', 'live', 'ended'] : ['approved', 'live'])
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(80)

      const { data, error } = await request
      if (error) {
        const msg = `${error.message || ''}`.toLowerCase()
        if (msg.includes('schema') || msg.includes('relation') || msg.includes('does not exist')) {
          setSchemaMissing(true)
          setProjects([])
          return
        }
        throw error
      }
      setSchemaMissing(false)
      setProjects(data || [])
    } catch (error) {
      toast.error(friendlyError(error, 'Calendar could not refresh.'))
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/calendar/status')
      const data = await res.json()
      if (res.ok) {
        setStatus(data)
        if (data?.schemaMissing) setSchemaMissing(true)
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchStatus()
  }, [fetchProjects, fetchStatus])

  useEffect(() => {
    const refreshOnResume = () => fetchProjects()
    window.addEventListener('alphahub:resume', refreshOnResume)
    return () => window.removeEventListener('alphahub:resume', refreshOnResume)
  }, [fetchProjects])

  const visibleProjects = useMemo(() => {
    return projects
      .filter(project => tabFilter(project, activeTab))
      .filter(project => chain === 'all' || normalizeChain(project.chain) === chain)
      .filter(project => {
        if (!query.trim()) return true
        const needle = query.toLowerCase()
        return [project.name, project.contract_address, project.mint_url, project.source]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(needle))
      })
      .sort((a, b) => scoreFor(b, activeTab) - scoreFor(a, activeTab))
  }, [activeTab, chain, projects, query])

  const runSync = async () => {
    if (calendarNotReady) {
      toast.error('Install the Calendar SQL migration in Supabase before running sync.')
      return
    }
    setSyncing(true)
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ limit: 12 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Calendar sync failed')
      if (data?.schemaMissing) {
        setSchemaMissing(true)
        throw new Error(data.message || data.error || 'Calendar database table is not installed yet.')
      }
      if (data?.ok === false) throw new Error(data.error || 'Calendar sync failed')
      toast.success(`Calendar sync complete: ${data.totalImported || 0} imported, ${data.totalUpdated || 0} updated.`)
      fetchProjects()
      fetchStatus()
    } catch (error) {
      toast.error(friendlyError(error, 'Calendar sync could not run.'))
    } finally {
      setSyncing(false)
    }
  }

  const resetForm = () => setForm({
    name: '',
    chain: 'base',
    mint_date: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    mint_price: '',
    mint_type: 'unknown',
    website_url: '',
    x_url: '',
    discord_url: '',
    mint_url: '',
    contract_address: '',
    image_url: '',
    notes: '',
  })

  const submitProject = async () => {
    if (!form.name.trim()) {
      toast.error('Project name is required')
      return
    }
    if (!form.contract_address.trim() && !form.mint_url.trim() && !form.website_url.trim() && !form.x_url.trim()) {
      toast.error('Add a contract, mint page, website, or X link')
      return
    }
    setSubmitting(true)
    try {
      const chainValue = normalizeChain(form.chain)
      const row = {
        name: form.name.trim(),
        image_url: form.image_url.trim() || null,
        description: form.notes.trim() || null,
        chain: chainValue,
        chain_id: chainIdFor(chainValue),
        contract_address: form.contract_address.trim() || null,
        mint_url: form.mint_url.trim() || null,
        website_url: form.website_url.trim() || null,
        x_url: form.x_url.trim() || null,
        discord_url: form.discord_url.trim() || null,
        mint_date: form.mint_date ? new Date(form.mint_date).toISOString() : null,
        mint_price: form.mint_price.trim() || null,
        mint_type: form.mint_type || 'unknown',
        source_url: form.mint_url.trim() || form.website_url.trim() || form.x_url.trim() || null,
        created_by_wallet: address?.toLowerCase() || null,
      }
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(row),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not submit calendar project')
      toast.success(isAdmin ? 'Calendar project added.' : 'Project submitted for review.')
      resetForm()
      setSubmitOpen(false)
      fetchProjects()
    } catch (error) {
      toast.error(friendlyError(error, 'Could not submit this calendar project.'))
    } finally {
      setSubmitting(false)
    }
  }

  const updateStatus = async (project, status) => {
    if (!isAdmin) return
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ projectId: project.id, status }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not update project status')
      toast.success(`Project marked ${status}.`)
      fetchProjects()
    } catch (error) {
      toast.error(friendlyError(error, 'Could not update project status.'))
    }
  }

  const addToMintGuard = async (project) => {
    if (!user?.id) {
      toast.error('Sign in again before adding to MintGuard.')
      return
    }
    if (!mintGuardEligible(project)) {
      toast.error('This project needs real metadata before it can be added to MintGuard.')
      return
    }
    toast.loading('Adding to MintGuard...', { id: 'calendar-add' })
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/add-to-mintguard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ projectId: project.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not add this project to MintGuard')
      toast.success('Added to MintGuard in Confirm Mode.', { id: 'calendar-add' })
    } catch (error) {
      toast.error(friendlyError(error, 'Could not add this project to MintGuard.'), { id: 'calendar-add' })
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CalendarDays size={20} className="text-accent" />
            <h1 className="text-xl font-bold">Alpha Hub Calendar</h1>
            <span className="badge badge-cyan">Discovery</span>
          </div>
          <p className="text-sm text-muted max-w-2xl">
            Discover trending mints, hidden gems, live launches, and new contracts before they hit the timeline.
          </p>
          {schemaMissing && (
            <p className="text-xs text-accent3 mt-2">
              Calendar database table is not installed yet. Apply the Calendar SQL migration, then run sync.
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {isAdmin && (
            <button onClick={runSync} disabled={syncing || calendarNotReady} className="btn-ghost flex items-center justify-center gap-2">
              {syncing ? <Loader size={15} className="animate-spin" /> : <Radar size={15} />}
              {calendarNotReady ? 'Install Calendar SQL First' : syncing ? 'Syncing...' : 'Run Sync Now'}
            </button>
          )}
          <button onClick={() => setSubmitOpen(true)} className="btn-primary flex items-center justify-center gap-2">
            <Plus size={15} />
            Submit Project
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <Metric label="Last Synced" value={timeAgo(status?.lastSync)} />
        <Metric label="Projects" value={status?.projectCount ?? projects.length} />
        <Metric label="Upcoming" value={status?.upcomingCount ?? 0} tone="text-accent3" />
        <Metric label="Live" value={status?.liveCount ?? 0} tone="text-green" />
        <Metric label="Pending" value={isAdmin ? (status?.pendingCount ?? 0) : '-'} tone="text-muted" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
        {TABS.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`card-sm text-left transition-all ${activeTab === tab.id ? 'border-accent bg-accent/8' : 'hover:border-border2'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon size={15} className={activeTab === tab.id ? 'text-accent' : 'text-muted'} />
                <span className="font-semibold text-sm">{tab.label}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{tab.copy}</p>
            </button>
          )
        })}
      </div>

      <div className="card mb-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className="input pl-9"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search project, contract, source..."
            />
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {['all', ...CHAINS.map(item => item.value)].map(item => (
              <button
                key={item}
                onClick={() => setChain(item)}
                className={`px-3 py-2 rounded-lg text-xs font-mono whitespace-nowrap border transition-colors ${
                  chain === item ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:text-text'
                }`}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-accent" />
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <Sparkles size={32} className="text-muted mb-3" />
          <h2 className="text-base font-bold">No verified project listings yet</h2>
          <p className="text-sm text-muted mt-2 max-w-md">
            {calendarNotReady
              ? 'Calendar storage is not ready yet. Apply the Calendar SQL migration in Supabase before syncing real projects.'
              : 'OpenSea, Alchemy, or Zora source data is needed for curated project listings. Raw onchain contracts only appear under New Contracts for review.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mt-4">
            {isAdmin && !calendarNotReady && <button onClick={runSync} disabled={syncing} className="btn-primary text-xs">{syncing ? 'Syncing...' : 'Run Sync Now'}</button>}
            {isAdmin && calendarNotReady && <button disabled className="btn-ghost text-xs">Install Calendar SQL First</button>}
            <button onClick={() => setSubmitOpen(true)} className="btn-ghost text-xs">Submit Project</button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {visibleProjects.map(project => (
            <ProjectCard
              key={project.id}
              project={project}
              tab={activeTab}
              isAdmin={isAdmin}
              onOpen={() => setSelectedProject(project)}
              onAdd={() => addToMintGuard(project)}
              onStatus={status => updateStatus(project, status)}
            />
          ))}
        </div>
      )}

      {submitOpen && (
        <SubmitModal
          form={form}
          setForm={setForm}
          submitting={submitting}
          onClose={() => setSubmitOpen(false)}
          onSubmit={submitProject}
          isAdmin={isAdmin}
        />
      )}

      {selectedProject && (
        <DetailDrawer
          project={selectedProject}
          isAdmin={isAdmin}
          onClose={() => setSelectedProject(null)}
          onAdd={() => addToMintGuard(selectedProject)}
          onStatus={status => updateStatus(selectedProject, status)}
        />
      )}
    </div>
  )
}

function ProjectCard({ project, tab, isAdmin, onOpen, onAdd, onStatus }) {
  const live = isLive(project)
  const eligible = mintGuardEligible(project)
  const launchReady = isLaunchReadyCalendarProject(project)
  const rankValue = tab === 'hidden-gems'
    ? project.hidden_gem_score || 0
    : tab === 'new-contracts'
    ? project.source_confidence || 'review'
    : project.hype_score || 0
  const risk = Number(project.risk_score || 0)
  const needsReview = !launchReady || (project.source_confidence || project.mint_date_confidence || 'low') === 'low'

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card overflow-hidden p-4">
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 rounded-lg bg-surface2 border border-border overflow-hidden flex items-center justify-center shrink-0">
          {project.image_url ? (
            <img src={project.image_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <Sparkles size={22} className="text-accent" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {live && <span className="badge badge-green animate-pulse-slow">LIVE NOW</span>}
            <span className="badge badge-cyan">{normalizeChain(project.chain).toUpperCase()}</span>
            <span className={`badge ${confidenceClass(project.source_confidence || project.mint_date_confidence)}`}>{confidenceText(project)}</span>
            {(project.status === 'pending_review' || !launchReady) && <span className="badge badge-yellow">Needs Review</span>}
          </div>
          <h2 className="font-bold truncate">{projectTitle(project)}</h2>
          <p className="text-xs text-muted mt-1 line-clamp-2">{projectSummary(project)}</p>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono font-bold ${live ? 'text-green' : 'text-accent3'}`}>{countdown(project)}</div>
          <div className="text-[10px] text-muted uppercase tracking-widest mt-1">{project.mint_price || 'Price TBA'}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Signal label={tab === 'hidden-gems' ? 'Gem score' : 'Hype'} value={rankValue} />
        <Signal label="Mints" value={project.mint_count || 0} />
        <Signal label="Risk" value={project.risk_score ?? 'Review'} tone={risk > 60 ? 'text-accent2' : 'text-green'} />
        <Signal label="Source" value={sourceLabel(project.source)} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Clock size={13} />
        <span>{formatTime(project)}</span>
        {project.contract_address && <span className="font-mono text-accent">{shortAddress(project.contract_address)}</span>}
        {needsReview && <span className="text-accent3">Verify official links before minting</span>}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mt-4">
        <button
          onClick={onAdd}
          disabled={!eligible}
          className={`flex-1 ${eligible ? 'btn-primary' : 'btn-ghost opacity-60 cursor-not-allowed'}`}
          title={eligible ? 'Add this sourced project to MintGuard' : 'Needs real metadata before MintGuard'}
        >
          {eligible ? 'Add to MintGuard' : 'Needs Metadata'}
        </button>
        <button onClick={onOpen} className="btn-ghost flex-1">Details</button>
        {project.source_url && (
          <a href={project.source_url} target="_blank" rel="noreferrer" className="btn-ghost flex items-center justify-center gap-2">
            <ExternalLink size={13} />
          </a>
        )}
      </div>

      {isAdmin && (
        <div className="flex gap-2 mt-3">
          <button onClick={() => onStatus('approved')} className="btn-ghost text-xs flex-1">Approve</button>
          <button onClick={() => onStatus('live')} className="btn-ghost text-xs flex-1">Mark Live</button>
          <button onClick={() => onStatus('hidden')} className="btn-danger text-xs flex-1">Hide</button>
        </div>
      )}
    </motion.div>
  )
}

function Signal({ label, value, tone = 'text-accent' }) {
  return (
    <div className="rounded-lg border border-border bg-surface2 px-3 py-2 min-w-0">
      <div className={`font-bold truncate ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-muted mt-0.5">{label}</div>
    </div>
  )
}

function Metric({ label, value, tone = 'text-accent' }) {
  return (
    <div className="metric-card">
      <div className={`text-lg font-bold ${tone}`}>{value}</div>
      <div className="section-label mt-1 mb-0 text-[10px]">{label}</div>
    </div>
  )
}

function SubmitModal({ form, setForm, submitting, onClose, onSubmit, isAdmin }) {
  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-border">
          <h2 className="font-bold">{isAdmin ? 'Add Calendar Project' : 'Submit Calendar Project'}</h2>
          <p className="text-xs text-muted mt-1">Add official links, mint time, and contract details. Times are stored in UTC.</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Project name" value={form.name} onChange={value => update('name', value)} required />
            <label>
              <span className="section-label block mb-2">Chain</span>
              <select className="select" value={form.chain} onChange={event => update('chain', event.target.value)}>
                {CHAINS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Contract address" value={form.contract_address} onChange={value => update('contract_address', value)} placeholder="0x..." />
            <Field label="Mint page URL" value={form.mint_url} onChange={value => update('mint_url', value)} placeholder="OpenSea, Zora, Manifold..." />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Website" value={form.website_url} onChange={value => update('website_url', value)} />
            <Field label="X link" value={form.x_url} onChange={value => update('x_url', value)} />
            <Field label="Discord" value={form.discord_url} onChange={value => update('discord_url', value)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label>
              <span className="section-label block mb-2">Mint date/time</span>
              <input className="input" type="datetime-local" value={form.mint_date} onChange={event => update('mint_date', event.target.value)} />
            </label>
            <Field label="Timezone" value={form.timezone} onChange={value => update('timezone', value)} />
            <Field label="Mint price" value={form.mint_price} onChange={value => update('mint_price', value)} placeholder="0.04 ETH / TBA" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label>
              <span className="section-label block mb-2">Mint type</span>
              <select className="select" value={form.mint_type} onChange={event => update('mint_type', event.target.value)}>
                {['unknown', 'public', 'allowlist', 'fcfs', 'free', 'paid'].map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <Field label="Image URL" value={form.image_url} onChange={value => update('image_url', value)} />
          </div>
          <label>
            <span className="section-label block mb-2">Notes</span>
            <textarea className="input min-h-24" value={form.notes} onChange={event => update('notes', event.target.value)} placeholder="Why this should be tracked, official source, community notes..." />
          </label>
          <div className="rounded-lg border border-accent/20 bg-accent/8 p-3 text-xs text-muted">
            User submissions enter review. Admin submissions go live immediately. Low-confidence projects must be confirmed before Auto Beta.
          </div>
        </div>
        <div className="p-5 border-t border-border flex flex-col sm:flex-row gap-2">
          <button disabled={submitting} onClick={onSubmit} className="btn-primary flex-1 flex items-center justify-center gap-2">
            {submitting ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
            {isAdmin ? 'Add Project' : 'Submit for Review'}
          </button>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder = '', required = false }) {
  return (
    <label>
      <span className="section-label block mb-2">{label}{required ? ' *' : ''}</span>
      <input className="input" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  )
}

function DetailDrawer({ project, isAdmin, onClose, onAdd, onStatus }) {
  const eligible = mintGuardEligible(project)
  const launchReady = isLaunchReadyCalendarProject(project)
  const needsReview = !launchReady || (project.source_confidence || project.mint_date_confidence || 'low') === 'low'
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex justify-end" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-xl bg-surface border-l border-border h-full overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="badge badge-cyan">{normalizeChain(project.chain).toUpperCase()}</span>
              <span className={`badge ${confidenceClass(project.source_confidence || project.mint_date_confidence)}`}>Confidence {(project.source_confidence || 'low').toUpperCase()}</span>
            </div>
            <h2 className="text-xl font-bold">{projectTitle(project)}</h2>
            <p className="text-sm text-muted mt-1">{projectSummary(project)}</p>
          </div>
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <Metric label="Countdown" value={countdown(project)} tone={isLive(project) ? 'text-green' : 'text-accent3'} />
          <Metric label="Risk" value={project.risk_score ?? 'Review'} tone={(project.risk_score || 0) > 60 ? 'text-accent2' : 'text-green'} />
          <Metric label="Whale Interest" value={project.whale_interest_score || 0} />
          <Metric label="Mint Events" value={project.mint_count || 0} />
        </div>

        <div className="space-y-3 text-sm">
          {needsReview && (
            <div className="rounded-lg border border-accent3/30 bg-accent3/10 p-3 text-sm text-accent3">
              This project needs review. Alpha Hub found activity, but official project metadata is limited. Add an official link or wait for Alchemy/OpenSea enrichment before using MintGuard.
            </div>
          )}
          <Info label="Mint time" value={formatTime(project)} />
          <Info label="Mint price" value={project.mint_price || 'TBA'} />
          <Info label="Mint type" value={project.mint_type || 'unknown'} />
          <Info label="Contract" value={project.contract_address || 'Not detected yet'} mono />
          <Info label="Source" value={`${sourceLabel(project.source)} · ${project.source_confidence || 'low'} confidence`} />
          <Info label="What Alpha Hub found" value={`Mint events: ${project.mint_count || 0}. Holders/supply signal: ${project.holder_count ?? 'unknown'}. Hidden gem score: ${project.hidden_gem_score || 0}. Hype score: ${project.hype_score || 0}.`} />
          <Info label="What is missing" value={[
            !project.image_url ? 'project image' : null,
            !project.website_url && !project.mint_url && !project.source_url ? 'official link' : null,
            !project.mint_price ? 'mint price' : null,
            !project.mint_time_confirmed ? 'confirmed mint time' : null,
          ].filter(Boolean).join(', ') || 'Core details available'} />
          <Info label="Auto Beta readiness" value={project.mint_time_confirmed ? 'Mint time confirmed. Still requires user opt-in and spend limits.' : 'Needs mint-time confirmation before Auto Beta.'} />
        </div>

        <div className="flex flex-col sm:flex-row gap-2 mt-6">
          <button
            onClick={onAdd}
            disabled={!eligible}
            className={`flex-1 ${eligible ? 'btn-primary' : 'btn-ghost opacity-60 cursor-not-allowed'}`}
          >
            {eligible ? 'Add to MintGuard' : 'Needs Metadata'}
          </button>
          {project.source_url && <a className="btn-ghost flex-1 text-center" href={project.source_url} target="_blank" rel="noreferrer">Open Source</a>}
        </div>
        {isAdmin && (
          <div className="flex gap-2 mt-3">
            <button onClick={() => onStatus('approved')} className="btn-ghost text-xs flex-1">Approve</button>
            <button onClick={() => onStatus('rejected')} className="btn-danger text-xs flex-1">Reject</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Info({ label, value, mono = false }) {
  return (
    <div className="rounded-lg border border-border bg-surface2 p-3">
      <div className="section-label mb-1">{label}</div>
      <div className={`${mono ? 'font-mono text-xs break-all' : ''}`}>{value}</div>
    </div>
  )
}
