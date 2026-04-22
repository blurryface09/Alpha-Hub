import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Zap, Trash2, Clock, ChevronDown, ChevronUp, ToggleLeft, ToggleRight, ExternalLink, RefreshCw, Twitter, AlertCircle, Gift, Bell } from 'lucide-react'
import toast from 'react-hot-toast'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY

const STATUS_STYLES = {
  upcoming:  { dot: 'dot-warning', badge: 'badge-yellow', label: 'UPCOMING' },
  live:      { dot: 'dot-live',    badge: 'badge-green',  label: 'LIVE NOW' },
  minted:    { dot: 'dot-dead',    badge: 'badge-cyan',   label: 'MINTED'  },
  missed:    { dot: 'dot-dead',    badge: 'badge-red',    label: 'MISSED'  },
  cancelled: { dot: 'dot-dead',    badge: 'badge-red',    label: 'CANCELLED' },
}

const WL_BADGE = {
  GTD:     'badge-green',
  FCFS:    'badge-yellow',
  RAFFLE:  'badge-purple',
  UNKNOWN: 'badge-cyan',
}

function Countdown({ mintDate }) {
  const [timeLeft, setTimeLeft] = React.useState('')
  React.useEffect(() => {
    const update = () => {
      const diff = new Date(mintDate) - new Date()
      if (diff <= 0) { setTimeLeft('LIVE NOW'); return }
      const d = Math.floor(diff / 86400000)
      const h = Math.floor((diff % 86400000) / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      if (d > 0) setTimeLeft(`${d}d ${h}h ${m}m`)
      else if (h > 0) setTimeLeft(`${h}h ${m}m ${s}s`)
      else setTimeLeft(`${m}m ${s}s`)
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [mintDate])
  return <span className="font-mono text-xs text-accent3">{timeLeft}</span>
}

async function fetchProjectIntel(project, retries = 3) {
  // Use Vercel env key first, fall back to user-entered key in Settings
  let geminiKey = GEMINI_KEY
  if (!geminiKey || geminiKey === 'your_gemini_api_key') {
    try {
      const stored = localStorage.getItem('alphahub-settings')
      if (stored) geminiKey = JSON.parse(stored)?.state?.geminiKey
    } catch {}
  }
  if (!geminiKey || geminiKey === 'your_gemini_api_key') {
    return { error: 'No Gemini API key found — add VITE_GEMINI_API_KEY to Vercel environment variables' }
  }

  const prompt = `You are a crypto/NFT project researcher. Research this NFT project and provide intelligence:

Project: ${project.name}
Source URL: ${project.source_url || 'unknown'}
WL Type: ${project.wl_type}
Chain: ${project.chain}
Mint Date: ${project.mint_date || 'not set'}
Notes: ${project.notes || 'none'}

Based on the project name and URL, provide a JSON response (no markdown, no backticks, just raw JSON) with:
{
  "summary": "2 sentence description of what this NFT project is",
  "wl_giveaway_likely": true or false,
  "giveaway_note": "if likely, describe what type of giveaway (RT to win, Discord role, etc), else empty string",
  "red_flags": ["list of concerns or empty array"],
  "green_flags": ["list of positives or empty array"],
  "hype_score": 5,
  "hype_reason": "one sentence why this score",
  "advice": "one sharp sentence — should they mint or skip?",
  "discord_tip": "what channels/roles to check to confirm WL",
  "twitter_tip": "exact search terms to find WL giveaways for this project on X"
}`

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        })
      })
      const d = await r.json()
      if (d.error) {
        if (d.error.code === 429 || d.error.status === 'RESOURCE_EXHAUSTED') {
          if (attempt < retries) {
            // Wait longer each retry: 5s, 10s, 20s
            const wait = 5000 * Math.pow(2, attempt)
            await new Promise(res => setTimeout(res, wait))
            continue
          }
          return { error: `Rate limit hit — free tier allows 15 requests/min. Waited ${retries} times. Try again in 1 minute.` }
        }
        return { error: d.error.message }
      }
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text || ''
      // Strip markdown code blocks if present
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const jsonMatch = clean.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0])
        } catch {
          return { error: 'Response parsing failed — try again' }
        }
      }
      return { error: 'Invalid response format — try again' }
    } catch(e) {
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, 3000))
        continue
      }
      return { error: e.message }
    }
  }
  return { error: 'All retries failed — check your connection' }
}

export default function ProjectCard({ project, isMinting, onMint, onDelete, onStatusUpdate, onMintModeToggle }) {
  const [expanded, setExpanded] = useState(false)
  const [intel, setIntel] = useState(null)
  const [intelLoading, setIntelLoading] = useState(false)
  const status = STATUS_STYLES[project.status] || STATUS_STYLES.upcoming

  const handleFetchIntel = async () => {
    setIntelLoading(true)
    const result = await fetchProjectIntel(project)
    setIntel(result)
    setIntelLoading(false)
    if (result.error) toast.error(result.error)
    else if (result.wl_giveaway_likely) toast.success(`🎁 WL giveaway likely for ${project.name}!`)
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={`card border transition-all ${
        project.status === 'live' ? 'border-green/30 bg-green/3 glow-green' :
        project.status === 'minted' ? 'border-accent/20' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-1.5 flex-shrink-0">
          <div className={status.dot} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{project.name}</span>
                <span className={`badge ${status.badge} text-[10px]`}>{status.label}</span>
                <span className={`badge ${WL_BADGE[project.wl_type] || 'badge-cyan'} text-[10px]`}>{project.wl_type}</span>
                <span className={`badge text-[10px] ${project.chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
                  {(project.chain || 'eth').toUpperCase()}
                </span>
                {intel?.wl_giveaway_likely && (
                  <span className="badge badge-green text-[10px] animate-pulse-slow">🎁 WL GIVEAWAY</span>
                )}
              </div>

              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                {project.mint_date && (
                  <div className="flex items-center gap-1.5">
                    <Clock size={11} className="text-muted" />
                    {project.status === 'upcoming'
                      ? <Countdown mintDate={project.mint_date} />
                      : <span className="font-mono text-xs text-muted">{new Date(project.mint_date).toLocaleDateString()}</span>
                    }
                  </div>
                )}
                {project.mint_price && <span className="text-xs text-muted">{project.mint_price}</span>}
                {project.max_mint > 1 && <span className="text-xs text-muted">max {project.max_mint}</span>}
                {intel?.hype_score && (
                  <span className={`text-xs font-mono ${intel.hype_score >= 7 ? 'text-green' : intel.hype_score >= 4 ? 'text-accent3' : 'text-muted'}`}>
                    Hype: {intel.hype_score}/10
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={onMintModeToggle}
                className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-all ${
                  project.mint_mode === 'auto'
                    ? 'border-green/40 text-green bg-green/8'
                    : 'border-border2 text-muted hover:border-accent hover:text-accent'
                }`}
              >
                {project.mint_mode === 'auto' ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
                {project.mint_mode === 'auto' ? 'Auto' : 'Confirm'}
              </button>

              {(project.status === 'live' || project.status === 'upcoming') && project.contract_address && (
                <button
                  onClick={onMint}
                  disabled={isMinting}
                  className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5"
                >
                  {isMinting ? <div className="spinner w-3 h-3" /> : <Zap size={12} />}
                  {isMinting ? 'Minting...' : 'Mint'}
                </button>
              )}

              <button onClick={() => setExpanded(!expanded)} className="text-muted hover:text-text p-1">
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">

          {/* Quick info */}
          <div className="space-y-2">
            {project.contract_address && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Contract</span>
                <span className="font-mono text-accent">{project.contract_address.slice(0,16)}...{project.contract_address.slice(-6)}</span>
              </div>
            )}
            {project.source_url && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Source</span>
                <a href={project.source_url} target="_blank" rel="noopener noreferrer" className="text-accent flex items-center gap-1 hover:underline">
                  View <ExternalLink size={10} />
                </a>
              </div>
            )}
            {project.gas_limit && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Gas limit</span>
                <span className="font-mono">{project.gas_limit.toLocaleString()}</span>
              </div>
            )}
            {project.notes && (
              <div className="text-xs text-muted bg-surface2 rounded-lg p-2">{project.notes}</div>
            )}
          </div>

          {/* Project Intel Section */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Bell size={12} className="text-accent" />
                <span className="text-xs font-mono text-muted uppercase tracking-wider">Project Intel</span>
              </div>
              <button
                onClick={handleFetchIntel}
                disabled={intelLoading}
                className="btn-ghost text-xs px-2 py-1 flex items-center gap-1.5"
              >
                {intelLoading
                  ? <div className="spinner w-3 h-3" />
                  : <RefreshCw size={11} />
                }
                {intelLoading ? 'Fetching...' : intel ? 'Refresh' : 'Fetch Intel'}
              </button>
            </div>

            {!intel && !intelLoading && (
              <p className="text-xs text-muted2 italic">
                Click "Fetch Intel" to get AI analysis — WL giveaway detection, hype score, red flags and tips.
              </p>
            )}

            {intel && !intel.error && (
              <div className="space-y-2.5">
                {/* Summary */}
                {intel.summary && (
                  <p className="text-xs text-text leading-relaxed bg-surface2 rounded-lg p-2.5">
                    {intel.summary}
                  </p>
                )}

                {/* Hype + Advice */}
                <div className="grid grid-cols-2 gap-2">
                  {intel.hype_score && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className={`text-lg font-bold ${intel.hype_score >= 7 ? 'text-green' : intel.hype_score >= 4 ? 'text-accent3' : 'text-accent2'}`}>
                        {intel.hype_score}/10
                      </div>
                      <div className="text-[10px] text-muted uppercase tracking-wider">Hype Score</div>
                      {intel.hype_reason && <div className="text-[10px] text-muted mt-1">{intel.hype_reason}</div>}
                    </div>
                  )}
                  {intel.advice && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">Advice</div>
                      <div className="text-xs text-text">{intel.advice}</div>
                    </div>
                  )}
                </div>

                {/* WL Giveaway alert */}
                {intel.wl_giveaway_likely && (
                  <div className="bg-green/8 border border-green/20 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Gift size={12} className="text-green" />
                      <span className="text-xs font-semibold text-green">WL Giveaway Likely</span>
                    </div>
                    <p className="text-xs text-text">{intel.giveaway_note}</p>
                  </div>
                )}

                {/* Flags */}
                {intel.red_flags?.length > 0 && (
                  <div className="bg-accent2/5 border border-accent2/15 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <AlertCircle size={11} className="text-accent2" />
                      <span className="text-[10px] font-mono text-accent2 uppercase tracking-wider">Red Flags</span>
                    </div>
                    <ul className="space-y-0.5">
                      {intel.red_flags.map((f, i) => (
                        <li key={i} className="text-xs text-text flex items-start gap-1.5">
                          <span className="text-accent2 mt-0.5">●</span>{f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {intel.green_flags?.length > 0 && (
                  <div className="bg-green/5 border border-green/15 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[10px] font-mono text-green uppercase tracking-wider">✓ Green Flags</span>
                    </div>
                    <ul className="space-y-0.5">
                      {intel.green_flags.map((f, i) => (
                        <li key={i} className="text-xs text-text flex items-start gap-1.5">
                          <span className="text-green mt-0.5">●</span>{f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Tips */}
                <div className="grid grid-cols-1 gap-2">
                  {intel.twitter_tip && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">🐦 X/Twitter Tip</div>
                      <p className="text-xs text-text">{intel.twitter_tip}</p>
                    </div>
                  )}
                  {intel.discord_tip && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">💬 Discord Tip</div>
                      <p className="text-xs text-text">{intel.discord_tip}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {intel?.error && (
              <p className="text-xs text-accent2">⚠ {intel.error}</p>
            )}
          </div>

          {/* Status controls */}
          <div className="flex items-center gap-2 pt-1 flex-wrap border-t border-border">
            <span className="text-xs text-muted">Set status:</span>
            {['upcoming', 'live', 'minted', 'missed', 'cancelled'].map(s => (
              <button
                key={s}
                onClick={() => onStatusUpdate(s)}
                className={`text-xs px-2 py-0.5 rounded border transition-all ${
                  project.status === s ? 'border-accent text-accent' : 'border-border text-muted hover:border-border2'
                }`}
              >
                {s}
              </button>
            ))}
            <button onClick={onDelete} className="btn-danger ml-auto text-xs px-2 py-0.5">
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  )
}
