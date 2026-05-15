import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock, ExternalLink, Gem, Loader, Plus, Radar, Share2,
  Search, Shield, Sparkles, TrendingUp, Zap, Wand2
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useAccount } from 'wagmi'
import { useParams } from 'react-router-dom'
import { supabase, getAuthToken } from '../lib/supabase'
import { useAuthStore } from '../store'
import { useSubscription } from '../hooks/useSubscription'
import { friendlyError } from '../lib/errors'
import {
  calendarQualityScore,
  isActiveMintCalendarProject,
  isLaunchReadyCalendarProject,
  isRawCalendarDiscovery,
  mintGuardEligible,
} from '../lib/calendarQuality'
import { MINT_MODES, MINT_PHASES, recommendMintMode } from '../lib/mintModes'

const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET?.toLowerCase()

const TABS = [
  { id: 'trending', label: 'Trending', icon: TrendingUp, copy: 'Highest visible activity and strongest tracked-wallet signals.' },
  { id: 'hidden-gems', label: 'Hidden Gems', icon: Gem, copy: 'Low-noise mints with early contract, whale, or deployer signals.' },
  { id: 'minting-now', label: 'Minting Now', icon: Zap, copy: 'Live launches, warm countdowns, and mints that need fast review.' },
  { id: 'new-contracts', label: 'New Contracts', icon: Shield, copy: 'Fresh NFT-style contracts that need intelligence review.' },
]

const CHAINS = [
  { value: 'eth', label: 'Ethereum', chainId: 1 },
  { value: 'base', label: 'Base', chainId: 8453 },
  { value: 'apechain', label: 'ApeChain', chainId: 33139 },
  { value: 'solana', label: 'Solana', chainId: 0 },
]

function normalizeChain(chain) {
  const value = String(chain || 'eth').toLowerCase()
  if (value.includes('base')) return 'base'
  if (value.includes('ape')) return 'apechain'
  if (value.includes('sol')) return 'solana'
  return 'eth'
}

function chainIdFor(chain) {
  return CHAINS.find(item => item.value === normalizeChain(chain))?.chainId || 1
}

function scoreFor(project, tab) {
  const sourcePriority = { admin: 500, community: 450, opensea: 350, alchemy: 330, zora: 300, onchain: 0 }[project.source] || 100
  const quality = Number(project.quality_score || calendarQualityScore(project))
  if (tab === 'hidden-gems') return project.hidden_gem_score || 0
  if (tab === 'new-contracts') return (project.first_seen_at ? new Date(project.first_seen_at).getTime() : 0) + quality
  if (tab === 'minting-now') return sourcePriority + quality + (project.mint_count || project.hype_score || 0)
  return sourcePriority + quality + (project.hype_score || project.whale_interest_score || 0)
}

function isLive(project) {
  if (!project.mint_date) return false
  // Only trusted sources can use 'medium' confidence as confirmed for Live Now
  const trustedSource = ['opensea', 'alchemy', 'admin', 'community'].includes(project.source)
  const confidence = project.mint_date_confidence || project.source_confidence || 'low'
  const confirmed = ['high', 'manual', 'confirmed'].includes(confidence) ||
    (confidence === 'medium' && trustedSource)
  if (!confirmed && project.mint_status !== 'live_now') return false
  const date = new Date(project.mint_date).getTime()
  const now = Date.now()
  return date <= now && date > now - 12 * 60 * 60 * 1000
}

function friendlyMintStatus(project) {
  if (project.mint_status === 'tba') return 'TBA'
  if (project.mint_status === 'ended' || project.status === 'ended') return 'Ended'
  if (isLive(project)) return 'Live now'
  if (!project.contract_address) return 'Needs contract'
  if (!project.mint_date) return 'Needs time'
  if (!project.mint_url && !project.website_url) return 'Needs mint URL'
  const start = new Date(project.mint_date).getTime()
  if (Number.isFinite(start) && start > Date.now()) return 'Upcoming'
  return 'Needs review'
}

function tabFilter(project, tab) {
  const raw = isRawCalendarDiscovery(project)
  const quality = Number(project.quality_score || calendarQualityScore(project))
  if (tab === 'new-contracts') return raw || project.status === 'pending_review' || !project.mint_date
  if (tab === 'minting-now') return isActiveMintCalendarProject(project) && (quality >= 60 || project.source_confidence === 'high' || ['admin', 'community'].includes(project.source))
  if (!isLaunchReadyCalendarProject(project)) return false
  if (tab === 'hidden-gems') return quality >= 50 && ((project.hidden_gem_score || 0) >= (project.hype_score || 0) || (project.hype_score || 0) < 45)
  return quality >= 60
}

function countdown(project) {
  if (!project.mint_date) return 'Time needs review'
  const diff = new Date(project.mint_date).getTime() - Date.now()
  if (diff <= 0) return isLive(project) ? 'LIVE NOW' : 'Needs review'
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
  return 'Sourced mint opportunity. Confirm official details before arming Strike Mode.'
}

function confidenceText(project) {
  const confidence = project.source_confidence || project.mint_date_confidence || 'low'
  if (confidence === 'high') return 'High'
  if (confidence === 'medium') return 'Medium'
  return 'Needs review'
}

function shareUrl(project) {
  const code = project.share_code || project.share_slug || project.id
  return `${window.location.origin}/calendar/${encodeURIComponent(code)}`
}

async function copyShare(project) {
  const url = shareUrl(project)
  try {
    await navigator.clipboard?.writeText(url)
    toast.success('Share link copied.')
  } catch {
    toast.error('Could not copy link. Long-press and copy from details.')
  }
}

function ratingStorageKey(projectId) {
  return `alphahub:calendar-rating:${projectId}`
}

function readLocalRating(projectId) {
  if (typeof window === 'undefined') return null
  const value = Number(window.localStorage.getItem(ratingStorageKey(projectId)))
  return Number.isFinite(value) && value >= 1 && value <= 5 ? value : null
}

function writeLocalRating(projectId, rating) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ratingStorageKey(projectId), String(rating))
}

function mergeLocalRatings(projects) {
  return (projects || []).map(project => {
    const localRating = readLocalRating(project.id)
    if (!localRating) return project
    return {
      ...project,
      rating_avg: project.rating_avg || localRating,
      rating_count: Math.max(1, Number(project.rating_count || 0)),
      viewer_rating: localRating,
    }
  })
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
  const { shareCode } = useParams()
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
  const [ratingBusy, setRatingBusy] = useState(null)
  const [query, setQuery] = useState('')
  const [chain, setChain] = useState('all')
  const [intelInput, setIntelInput] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [detectedProject, setDetectedProject] = useState(null)
  const [selectedPhase, setSelectedPhase] = useState('unknown')
  const [selectedMode, setSelectedMode] = useState('safe')
  const [consoleSteps, setConsoleSteps] = useState([])
  const [form, setForm] = useState({
    name: '',
    chain: 'base',
    mint_date: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    mint_price: '',
    mint_type: 'unknown',
    mint_phase: 'unknown',
    website_url: '',
    x_url: '',
    discord_url: '',
    mint_url: '',
    contract_address: '',
    image_url: '',
    notes: '',
    community_name: '',
    community_x_handle: '',
    submitter_role: 'user',
  })
  const calendarNotReady = schemaMissing || status?.schemaMissing

  const fetchProjects = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      let request = supabase
        .from('calendar_projects')
        .select('*')
        .in('status', isAdmin ? ['pending_review', 'approved', 'live', 'ended'] : ['approved', 'live'])
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(isAdmin ? 60 : 36)

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
      setProjects(mergeLocalRatings(data || []))
    } catch (error) {
      toast.error(friendlyError(error, 'Calendar could not refresh.'))
      if (!silent) setProjects([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [isAdmin, shareCode])

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

  const lastResumeRefresh = useRef(0)

  useEffect(() => {
    const refreshOnResume = () => {
      if (Date.now() - lastResumeRefresh.current < 5 * 60 * 1000) return
      lastResumeRefresh.current = Date.now()
      fetchProjects({ silent: true })
    }
    window.addEventListener('alphahub:resume', refreshOnResume)
    return () => window.removeEventListener('alphahub:resume', refreshOnResume)
  }, [fetchProjects])

  const visibleProjects = useMemo(() => {
    return projects
      .filter(project => !shareCode || project.share_code?.toLowerCase() === shareCode.toLowerCase() || project.share_slug?.toLowerCase() === shareCode.toLowerCase())
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
  }, [activeTab, chain, projects, query, shareCode])

  const runSync = async () => {
    if (calendarNotReady) {
      toast.error('Install the Alpha Radar SQL migration in Supabase before running sync.')
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
      if (!res.ok) throw new Error(data.error || 'Alpha Radar sync failed')
      if (data?.schemaMissing) {
        setSchemaMissing(true)
        throw new Error(data.message || data.error || 'Alpha Radar database table is not installed yet.')
      }
      if (data?.ok === false) throw new Error(data.error || 'Alpha Radar sync failed')
      toast.success(`Alpha Radar sync complete: ${data.totalImported || 0} imported, ${data.totalUpdated || 0} updated.`)
      fetchProjects()
      fetchStatus()
    } catch (error) {
      toast.error(friendlyError(error, 'Alpha Radar sync could not run.'))
    } finally {
      setSyncing(false)
    }
  }

  const detectAlpha = async () => {
    if (!intelInput.trim()) {
      toast.error('Paste an OpenSea, Zora, mint site, X post, or contract first.')
      return
    }
    setDetecting(true)
    setConsoleSteps(['Preparing project', 'Detecting phase'])
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/intelligence/detect-project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ input: intelInput }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not detect project')
      const project = data.project || {}
      setDetectedProject(project)
      const phase = project.mintPhase || 'unknown'
      setSelectedPhase(phase)
      setSelectedMode(project.recommendedMode || recommendMintMode(phase, project.riskScore))
      setConsoleSteps(['Preparing project', 'Detecting phase', 'Checking contract'])
      setForm(prev => ({
        ...prev,
        name: project.name || prev.name,
        chain: normalizeChain(project.chain || prev.chain),
        contract_address: project.contractAddress || prev.contract_address,
        mint_url: project.mintUrl || prev.mint_url,
        website_url: project.websiteUrl || prev.website_url,
        x_url: project.xUrl || prev.x_url,
        image_url: project.imageUrl || prev.image_url,
        mint_date: project.mintDate ? project.mintDate.slice(0, 16) : prev.mint_date,
        mint_type: project.mintPhase || prev.mint_type,
        mint_phase: project.mintPhase || prev.mint_phase,
        mint_price: project.mintPrice || prev.mint_price,
        notes: project.notes?.join(' ') || prev.notes,
      }))
      toast.success('Alpha detected. Confirm phase and mint mode.')
    } catch (error) {
      toast.error(friendlyError(error, 'Could not detect this alpha.'))
      setConsoleSteps(['Preparing project', 'Failed'])
    } finally {
      setDetecting(false)
    }
  }

  const prepareDetectedMint = async () => {
    const project = detectedProject
    if (!project) {
      toast.error('Detect or select a project first.')
      return
    }
    setConsoleSteps(['Preparing project', 'Detecting phase', 'Checking contract', 'Preparing transaction'])
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/mint/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: project.name,
          contractAddress: project.contractAddress,
          chain: project.chain,
          mintUrl: project.mintUrl || project.sourceUrl,
          walletAddress: address,
          phase: selectedPhase,
          mode: selectedMode,
          riskScore: project.riskScore,
          maxTotalSpend: '0.05',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not prepare mint')
      setConsoleSteps(['Preparing project', 'Detecting phase', 'Checking contract', 'Preparing transaction', 'Simulating mint', selectedMode === 'strike' ? 'Watching mint window' : 'Gas locked'])
      toast.success(data.message || `${MINT_MODES[selectedMode]?.label || 'Mint'} prepared.`)
    } catch (error) {
      setConsoleSteps(prev => [...prev, 'Failed'])
      toast.error(friendlyError(error, 'Mint preparation failed. Nothing was sent.'))
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
    community_name: '',
    community_x_handle: '',
    submitter_role: 'user',
    mint_phase: 'unknown',
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
        mint_type: form.mint_type || form.mint_phase || 'unknown',
        mint_phase: form.mint_phase || form.mint_type || 'unknown',
        recommended_mode: recommendMintMode(form.mint_phase || form.mint_type, 50),
        source_url: form.mint_url.trim() || form.website_url.trim() || form.x_url.trim() || null,
        created_by_wallet: address?.toLowerCase() || null,
        community_name: form.community_name.trim() || null,
        community_x_handle: form.community_x_handle.trim() || null,
        submitter_role: form.submitter_role || (isAdmin ? 'admin' : 'user'),
        submitted_by_label: form.community_name.trim() || form.community_x_handle.trim() || null,
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
      if (!res.ok) throw new Error(data.error || 'Could not submit alpha')
      toast.success(isAdmin ? 'Alpha added.' : 'Alpha submitted for review.')
      resetForm()
      setSubmitOpen(false)
      fetchProjects()
    } catch (error) {
      toast.error(friendlyError(error, 'Could not submit this alpha.'))
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
    const reviewMode = !mintGuardEligible(project)
    toast.loading(reviewMode ? 'Adding as a review-only MintGuard project...' : 'Adding to MintGuard...', { id: 'calendar-add' })
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/add-to-mintguard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ calendarProjectId: project.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not add this project to MintGuard')
      toast.success(data.duplicate
        ? 'Already in MintGuard.'
        : reviewMode
        ? 'Added to MintGuard. Confirm details before Strike Mode.'
        : 'Added to MintGuard in Fast Mint mode.', { id: 'calendar-add' })
    } catch (error) {
      toast.error(friendlyError(error, 'Could not add this project to MintGuard.'), { id: 'calendar-add' })
    }
  }

  const saveProject = async (project) => {
    if (!user?.id) {
      toast.error('Sign in to save projects.')
      return
    }
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ projectId: project.id, walletAddress: address?.toLowerCase() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not save project')
      toast.success(data.save?.localOnly ? 'Saved on this device.' : 'Project saved.')
    } catch (error) {
      toast.error(friendlyError(error, 'Could not save project.'))
    }
  }

  const rateProject = async (project, rating) => {
    if (!user?.id) {
      toast.error('Sign in to rate projects.')
      return
    }
    setRatingBusy(project.id)
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/rate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ projectId: project.id, rating, walletAddress: address?.toLowerCase() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not save rating')
      writeLocalRating(project.id, rating)
      setProjects(prev => prev.map(item => item.id === project.id
        ? {
            ...item,
            rating_avg: data.ratingAvg ?? rating,
            rating_count: data.ratingCount ?? Math.max(1, Number(item.rating_count || 0)),
            viewer_rating: rating,
          }
        : item))
      setSelectedProject(prev => prev?.id === project.id
        ? {
            ...prev,
            rating_avg: data.ratingAvg ?? rating,
            rating_count: data.ratingCount ?? Math.max(1, Number(prev.rating_count || 0)),
            viewer_rating: rating,
          }
        : prev)
      toast.success(data.localOnly ? 'Rating saved with fallback storage.' : 'Rating saved.')
    } catch (error) {
      writeLocalRating(project.id, rating)
      setProjects(prev => prev.map(item => item.id === project.id
        ? {
            ...item,
            rating_avg: item.rating_avg || rating,
            rating_count: Math.max(1, Number(item.rating_count || 0)),
            viewer_rating: rating,
          }
        : item))
      setSelectedProject(prev => prev?.id === project.id
        ? {
            ...prev,
            rating_avg: prev.rating_avg || rating,
            rating_count: Math.max(1, Number(prev.rating_count || 0)),
            viewer_rating: rating,
          }
        : prev)
      toast.success('Rating saved on this device.')
    } finally {
      setRatingBusy(null)
    }
  }

  const cleanupCalendar = async () => {
    if (!isAdmin) return
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/calendar/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data.error || 'Could not clean Alpha Radar')
      toast.success(`Cleanup complete: ${data.downgraded || 0} moved to review.`)
      fetchProjects()
      fetchStatus()
    } catch (error) {
      toast.error(friendlyError(error, 'Could not clean Alpha Radar.'))
    }
  }

  return (
    <div>
      <div className="hero-panel mb-6">
        <div className="hero-content flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="mascot-orb"><Radar size={17} /></span>
              <span className="badge badge-cyan">Alpha Radar</span>
              <span className="badge badge-purple">Mint intelligence</span>
            </div>
            <h1 className="text-3xl font-black tracking-tight">Find, understand, and mint faster.</h1>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              Paste a link or browse live signals. Alpha Radar detects project basics, mint phase, timing, risk, and the safest execution mode.
            </p>
            {schemaMissing && (
              <p className="text-xs text-accent3 mt-3">
                Alpha Radar storage needs the SQL migration before live sync can save projects.
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {isAdmin && (
              <button onClick={runSync} disabled={syncing || calendarNotReady} className="btn-ghost flex items-center justify-center gap-2">
                {syncing ? <Loader size={15} className="animate-spin" /> : <Radar size={15} />}
                {calendarNotReady ? 'Install Alpha Radar SQL First' : syncing ? 'Syncing...' : 'Run Sync'}
              </button>
            )}
            {isAdmin && (
              <button onClick={cleanupCalendar} disabled={calendarNotReady} className="btn-ghost flex items-center justify-center gap-2">
                Clean low-quality rows
              </button>
            )}
            {isAdmin && (
              <button onClick={() => setSubmitOpen(true)} className="btn-primary flex items-center justify-center gap-2">
                <Plus size={15} />
                Add Alpha
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card mb-5 overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Wand2 size={16} className="text-accent" />
              <h2 className="font-bold">Paste alpha, get a mint plan</h2>
            </div>
            <p className="text-sm text-muted">
              OpenSea, Zora, mint sites, X posts, and contract addresses are supported. Technical details stay tucked away until you need them.
            </p>
            <div className="mt-4 flex flex-col sm:flex-row gap-2">
              <input
                className="input flex-1"
                value={intelInput}
                onChange={event => setIntelInput(event.target.value)}
                placeholder="Paste project link, X post, or contract..."
              />
              <button onClick={detectAlpha} disabled={detecting} className="btn-primary flex items-center justify-center gap-2">
                {detecting ? <Loader size={15} className="animate-spin" /> : <Radar size={15} />}
                Detect
              </button>
            </div>
          </div>
          <div className="w-full lg:w-[420px] rounded-2xl border border-border bg-surface2/70 p-3">
            <div className="section-label mb-2">Live Mint Console</div>
            <div className="space-y-2">
              {(consoleSteps.length ? consoleSteps : ['Waiting for alpha']).slice(-7).map((step, index) => (
                <div key={`${step}-${index}`} className="flex items-center gap-2 text-xs">
                  <span className={`h-2 w-2 rounded-full ${step === 'Failed' ? 'bg-red-400' : step === 'Stopped' ? 'bg-muted' : 'bg-accent'}`} />
                  <span className={step === 'Failed' ? 'text-red-300' : 'text-muted'}>{step}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {detectedProject && (
          <div className="mt-4 rounded-2xl border border-accent/20 bg-accent/8 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="badge badge-cyan">{normalizeChain(detectedProject.chain).toUpperCase()}</span>
                  <span className="badge badge-yellow">Confidence {detectedProject.confidenceScore ?? detectedProject.confidence ?? 'low'}</span>
                  <span className="badge badge-purple">{friendlyMintStatus({ ...detectedProject, contract_address: detectedProject.contractAddress, mint_date: detectedProject.mintDate, mint_status: detectedProject.mintStatus, source_confidence: detectedProject.confidence })}</span>
                  <span className="badge badge-purple">{MINT_PHASES.find(item => item.id === selectedPhase)?.label || 'Not sure'}</span>
                </div>
                <h3 className="font-bold">{detectedProject.name}</h3>
                <p className="text-xs text-muted mt-1">
                  Recommended: {MINT_MODES[selectedMode]?.label || 'Safe Mint'} · Risk {detectedProject.riskScore ?? 'review'}
                </p>
                {detectedProject.missingFields?.length > 0 && (
                  <p className="text-xs text-accent3 mt-1">
                    Missing: {detectedProject.missingFields.map(item => item.replace(/_/g, ' ')).join(', ')}
                  </p>
                )}
              </div>
              <button onClick={() => setSubmitOpen(true)} className="btn-ghost">Review & submit</button>
            </div>
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
              <label>
                <span className="section-label block mb-2">What phase are you minting?</span>
                <select
                  className="select"
                  value={selectedPhase}
                  onChange={event => {
                    const phase = event.target.value
                    setSelectedPhase(phase)
                    setSelectedMode(recommendMintMode(phase, detectedProject.riskScore))
                    setForm(prev => ({ ...prev, mint_phase: phase, mint_type: phase }))
                  }}
                >
                  {MINT_PHASES.map(item => <option key={item.id} value={item.id}>{item.label} - {item.copy}</option>)}
                </select>
              </label>
              <div>
                <span className="section-label block mb-2">Mint mode</span>
                <div className="grid grid-cols-3 gap-2">
                  {Object.values(MINT_MODES).map(mode => (
                    <button
                      key={mode.id}
                      onClick={() => setSelectedMode(mode.id)}
                      className={`rounded-xl border px-3 py-2 text-left transition-colors ${selectedMode === mode.id ? 'border-accent bg-accent/10 text-text' : 'border-border bg-surface text-muted'}`}
                    >
                      <div className="text-xs font-bold">{mode.shortLabel}</div>
                      <div className="text-[10px] leading-tight mt-1">{mode.id === 'strike' ? 'Vault required' : mode.id === 'fast' ? 'Prepared tx' : 'Wallet confirm'}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <button onClick={prepareDetectedMint} className="btn-primary flex-1">
                Prepare {MINT_MODES[selectedMode]?.label || 'Mint'}
              </button>
              <button onClick={() => setDetectedProject(null)} className="btn-ghost">Clear</button>
            </div>
            {selectedMode === 'strike' && (
              <p className="text-xs text-accent3 mt-3">
                {detectedProject.missingFields?.includes('contract_address')
                  ? 'Add contract address before Strike.'
                  : detectedProject.missingFields?.includes('mint_start_time')
                  ? 'Add mint time before Strike.'
                  : detectedProject.missingFields?.includes('mint_url')
                  ? 'Add mint URL before Strike.'
                  : 'Strike Mode uses Alpha Vault only after you enable a burner wallet, max spend, simulation, and safety switches. Never use your main wallet.'}
              </p>
            )}
          </div>
        )}
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
              placeholder="Search projects, share codes, links..."
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
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="alpha-loader" />
          <p className="mt-4 text-sm text-muted">Scanning fresh alpha...</p>
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <Sparkles size={32} className="text-muted mb-3" />
          <h2 className="text-base font-bold">No verified project listings yet</h2>
          <p className="text-sm text-muted mt-2 max-w-md">
            {calendarNotReady
              ? 'Alpha Radar storage is not ready yet. Apply the Alpha Radar SQL migration in Supabase before syncing real projects.'
              : 'OpenSea, Alchemy, or Zora source data is needed for curated project listings. Raw onchain contracts only appear under New Contracts for review.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mt-4">
            {isAdmin && !calendarNotReady && <button onClick={runSync} disabled={syncing} className="btn-primary text-xs">{syncing ? 'Syncing...' : 'Run Sync Now'}</button>}
            {isAdmin && calendarNotReady && <button disabled className="btn-ghost text-xs">Install Alpha Radar SQL First</button>}
            {isAdmin && <button onClick={() => setSubmitOpen(true)} className="btn-ghost text-xs">Add Alpha</button>}
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
              onSave={() => saveProject(project)}
              onStatus={status => updateStatus(project, status)}
              onRate={rating => rateProject(project, rating)}
              onShare={() => copyShare(project)}
              ratingBusy={ratingBusy === project.id}
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
          onSave={() => saveProject(selectedProject)}
          onStatus={status => updateStatus(selectedProject, status)}
          onRate={rating => rateProject(selectedProject, rating)}
          onShare={() => copyShare(selectedProject)}
          ratingBusy={ratingBusy === selectedProject.id}
        />
      )}
    </div>
  )
}

const ProjectCard = memo(function ProjectCard({ project, tab, isAdmin, onOpen, onAdd, onSave, onStatus, onRate, onShare, ratingBusy }) {
  const live = isLive(project)
  const launchReady = isLaunchReadyCalendarProject(project)
  const quality = Number(project.quality_score || calendarQualityScore(project))
  const rating = Number(project.viewer_rating || project.rating_avg || 0)
  const ratingCount = Number(project.rating_count || 0)
  const rankValue = tab === 'hidden-gems'
    ? project.hidden_gem_score || 0
    : tab === 'new-contracts'
    ? project.source_confidence || 'review'
    : project.hype_score || 0
  const risk = Number(project.risk_score || 0)
  const needsReview = !launchReady || (project.source_confidence || project.mint_date_confidence || 'low') === 'low'

  return (
    <div className="card overflow-hidden p-4 hover:border-accent/40 hover:-translate-y-0.5 transition-all duration-200">
      {project.image_url && (
        <div className="mb-4 aspect-[16/7] overflow-hidden rounded-2xl border border-border bg-surface2">
          <img src={project.image_url} alt={projectTitle(project)} className="h-full w-full object-cover" loading="lazy" />
        </div>
      )}
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
            {!live && <span className="badge badge-yellow">{friendlyMintStatus(project)}</span>}
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
        <Signal label="Quality" value={quality} tone={quality >= 60 ? 'text-green' : 'text-accent3'} />
        <Signal label="Risk" value={project.risk_score ?? 'Review'} tone={risk > 60 ? 'text-accent2' : 'text-green'} />
        <Signal label="Rating" value={ratingCount ? `${rating}/5` : 'New'} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Clock size={13} />
        <span>{formatTime(project)}</span>
        {project.contract_address && <span className="font-mono text-accent">{shortAddress(project.contract_address)}</span>}
        {project.share_code && <button onClick={() => navigator.clipboard?.writeText(project.share_code)} className="font-mono text-accent hover:underline">{project.share_code}</button>}
        {project.submitted_by_label && <span>Shared by {project.submitted_by_label}</span>}
        {needsReview && <span className="text-accent3">Verify official links before minting</span>}
      </div>

      <RatingControl rating={rating} ratingCount={ratingCount} onRate={onRate} busy={ratingBusy} />

      <div className="flex flex-col sm:flex-row gap-2 mt-4">
        <button onClick={onOpen} className="btn-primary flex-1">View Details</button>
        <button onClick={onAdd} className="btn-ghost flex-1">
          Add to My Mints
        </button>
        <button onClick={onSave} className="btn-ghost flex-1">
          Save
        </button>
        <button onClick={onShare} className="btn-ghost flex-1 flex items-center justify-center gap-2">
          <Share2 size={14} />
          Share
        </button>
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
    </div>
  )
})

function RatingControl({ rating, ratingCount, onRate, busy }) {
  return (
    <div className="mt-3 rounded-2xl border border-border bg-surface2/80 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1" aria-label="Project rating">
          {[1, 2, 3, 4, 5].map(value => {
            const active = value <= Math.round(rating)
            return (
              <button
                key={value}
                onClick={() => onRate?.(value)}
                disabled={busy}
                className={`text-xl leading-none transition-all hover:scale-125 active:scale-95 disabled:opacity-60 ${
                  active ? 'text-accent3 drop-shadow-[0_0_8px_rgba(255,184,77,0.35)]' : 'text-muted2 hover:text-accent3'
                }`}
                title={`Rate ${value} star${value > 1 ? 's' : ''}`}
              >
                ★
              </button>
            )
          })}
        </div>
        <div className="text-right">
          <div className="text-xs font-semibold text-text">{ratingCount ? `${Number(rating).toFixed(1)}/5` : 'New'}</div>
          <div className="text-[10px] text-muted">{busy ? 'Saving...' : ratingCount ? `${ratingCount} vote${ratingCount === 1 ? '' : 's'}` : 'Tap to rate'}</div>
        </div>
      </div>
    </div>
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
          <h2 className="font-bold">{isAdmin ? 'Add Alpha' : 'Share Alpha'}</h2>
          <p className="text-xs text-muted mt-1">Add the basics first. Official links and clear timing help the community trust it.</p>
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
              <span className="section-label block mb-2">Mint phase</span>
              <select className="select" value={form.mint_phase || form.mint_type} onChange={event => {
                update('mint_phase', event.target.value)
                update('mint_type', event.target.value)
              }}>
                {MINT_PHASES.map(item => <option key={item.id} value={item.id}>{item.label} - {item.copy}</option>)}
              </select>
            </label>
            <Field label="Image URL" value={form.image_url} onChange={value => update('image_url', value)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Community name" value={form.community_name} onChange={value => update('community_name', value)} />
            <Field label="Community X handle" value={form.community_x_handle} onChange={value => update('community_x_handle', value)} placeholder="@project" />
            <label>
              <span className="section-label block mb-2">Submitter role</span>
              <select className="select" value={form.submitter_role} onChange={event => update('submitter_role', event.target.value)}>
                {['user', 'cm', 'project_team', 'admin'].map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <label>
            <span className="section-label block mb-2">Notes</span>
            <textarea className="input min-h-24" value={form.notes} onChange={event => update('notes', event.target.value)} placeholder="Why this should be tracked, official source, community notes..." />
          </label>
          <div className="rounded-lg border border-accent/20 bg-accent/8 p-3 text-xs text-muted">
            User submissions enter review. Admin submissions can go live immediately. Low-confidence projects must be confirmed before Strike Mode.
          </div>
        </div>
        <div className="p-5 border-t border-border flex flex-col sm:flex-row gap-2">
          <button disabled={submitting} onClick={onSubmit} className="btn-primary flex-1 flex items-center justify-center gap-2">
            {submitting ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
            {isAdmin ? 'Publish Alpha' : 'Submit for Review'}
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

function DetailDrawer({ project, isAdmin, onClose, onAdd, onSave, onStatus, onRate, onShare, ratingBusy }) {
  const launchReady = isLaunchReadyCalendarProject(project)
  const needsReview = !launchReady || (project.source_confidence || project.mint_date_confidence || 'low') === 'low'
  const quality = Number(project.quality_score || calendarQualityScore(project))
  const rating = Number(project.viewer_rating || project.rating_avg || 0)
  const ratingCount = Number(project.rating_count || 0)
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex justify-end" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-2xl bg-surface border-l border-border h-full overflow-y-auto">
        {project.image_url ? (
          <div className="h-52 bg-surface2">
            <img src={project.image_url} alt={projectTitle(project)} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="h-36 bg-gradient-to-br from-accent/20 via-purple/10 to-accent2/10 flex items-center justify-center">
            <Sparkles size={36} className="text-accent" />
          </div>
        )}
        <div className="p-5">
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
          <Metric label="Quality" value={quality} tone={quality >= 60 ? 'text-green' : 'text-accent3'} />
          <Metric label="Risk" value={project.risk_score ?? 'Review'} tone={(project.risk_score || 0) > 60 ? 'text-accent2' : 'text-green'} />
          <Metric label="Rating" value={ratingCount ? `${rating}/5` : 'New'} />
        </div>

        <div className="rounded-lg border border-border bg-surface2 p-3 mb-4">
          <div className="section-label mb-2">Community Rating</div>
          <RatingControl rating={rating} ratingCount={ratingCount} onRate={onRate} busy={ratingBusy} />
        </div>

        <div className="space-y-3 text-sm">
          {needsReview && (
            <div className="rounded-lg border border-accent3/30 bg-accent3/10 p-3 text-sm text-accent3">
              This project needs review. Alpha Hub found activity, but official project metadata is limited. You can save it to My Mints, but confirm official links before Strike Mode.
            </div>
          )}
          <Info label="Mint time" value={formatTime(project)} />
          <Info label="Mint price" value={project.mint_price || 'TBA'} />
          <Info label="Mint type" value={project.mint_type || 'unknown'} />
          <Info label="Contract" value={project.contract_address || 'Not detected yet'} mono />
          <Info label="Source" value={`${sourceLabel(project.source)} · ${project.source_confidence || 'low'} confidence`} />
          <Info label="Share code" value={project.share_code || 'Generated after migration'} mono />
          <Info label="Submitted by" value={project.submitted_by_label || project.community_name || project.community_x_handle || 'Alpha Hub source sync'} />
          <Info label="What Alpha Hub found" value={`Mint events: ${project.mint_count || 0}. Holders/supply signal: ${project.holder_count ?? 'unknown'}. Hidden gem score: ${project.hidden_gem_score || 0}. Hype score: ${project.hype_score || 0}.`} />
          <Info label="What is missing" value={[
            !project.image_url ? 'project image' : null,
            !project.website_url && !project.mint_url && !project.source_url ? 'official link' : null,
            !project.mint_price ? 'mint price' : null,
            !project.mint_time_confirmed ? 'confirmed mint time' : null,
          ].filter(Boolean).join(', ') || 'Core details available'} />
          <Info label="Strike Mode readiness" value={project.mint_time_confirmed ? 'Mint time confirmed. Still requires user opt-in and spend limits.' : 'Needs mint-time confirmation before Strike Mode.'} />
        </div>

        <div className="flex flex-col sm:flex-row gap-2 mt-6">
          <button onClick={onAdd} className="btn-ghost flex-1">
            Add to My Mints
          </button>
          <button onClick={onSave} className="btn-ghost flex-1">
            Save
          </button>
          <button onClick={onShare} className="btn-primary flex-1 flex items-center justify-center gap-2">
            <Share2 size={14} />
            Copy Share Link
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
