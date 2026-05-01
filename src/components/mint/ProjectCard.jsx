import React, { useState } from 'react'
import LiveMintFeed from './LiveMintFeed'
import EditProjectModal from './EditProjectModal'
import { motion } from 'framer-motion'
import { Zap, Trash2, Clock, ChevronDown, ChevronUp, ToggleLeft, ToggleRight, ExternalLink, RefreshCw, Twitter, AlertCircle, Gift, Bell } from 'lucide-react'
import toast from 'react-hot-toast'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY

async function fetchProjectIntel(project) {
  if (!GROQ_KEY) return { error: 'No Groq API key. Add VITE_GROQ_API_KEY to Vercel.' }
  const prompt = `You are a crypto/NFT project researcher. Research this NFT project.

Project: ${project.name}
Source URL: ${project.source_url || 'unknown'}
WL Type: ${project.wl_type}
Chain: ${project.chain}
Mint Date: ${project.mint_date || 'not set'}
Notes: ${project.notes || 'none'}

Respond with ONLY valid JSON, no markdown:
{"summary":"2 sentence description","wl_giveaway_likely":false,"giveaway_note":"","red_flags":[],"green_flags":[],"hype_score":5,"hype_reason":"one sentence","advice":"one sharp sentence","discord_tip":"what to look for","twitter_tip":"search terms for X"}`

  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    })
    const d = await r.json()
    if (d.error) return { error: d.error.message }
    const text = d.choices?.[0]?.message?.content || ''
    // Strip markdown, code blocks, and any text before/after JSON
    const clean = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/^[^{]*/s, '')
      .trim()
    // Find the JSON object - be greedy to get the full object
    const jsonMatch = clean.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0])
      } catch {
        // Try to fix common JSON issues
        try {
          const fixed = jsonMatch[0]
            .replace(/,\s*}/g, '}')      // trailing commas
            .replace(/,\s*]/g, ']')      // trailing commas in arrays
            .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // unquoted keys
          return JSON.parse(fixed)
        } catch {
          // Last resort - return partial data from text
          return {
            summary: text.slice(0, 200),
            hype_score: 5,
            advice: 'AI response could not be fully parsed — try refreshing.',
            red_flags: [],
            green_flags: [],
            wl_giveaway_likely: false,
            giveaway_note: '',
            hype_reason: '',
            discord_tip: '',
            twitter_tip: '',
          }
        }
      }
    }
    // No JSON found — still return something useful
    return {
      summary: text.slice(0, 300),
      hype_score: 5,
      advice: text.slice(0, 150),
      red_flags: [],
      green_flags: [],
      wl_giveaway_likely: false,
      giveaway_note: '',
      hype_reason: '',
      discord_tip: '',
      twitter_tip: '',
    }
  } catch(e) {
    return { error: e.message }
  }
}

const STATUS_STYLES = {
  upcoming:  { dot: "dot-warning", badge: "badge-yellow", label: "UPCOMING" },
  live:      { dot: "dot-live",    badge: "badge-green",  label: "LIVE NOW" },
  minted:    { dot: "dot-dead",    badge: "badge-cyan",   label: "MINTED"   },
  missed:    { dot: "dot-dead",    badge: "badge-red",    label: "MISSED"   },
  cancelled: { dot: "dot-dead",    badge: "badge-red",    label: "CANCELLED" },
}

const WL_BADGE = {
  GTD:     "badge-green",
  FCFS:    "badge-yellow",
  RAFFLE:  "badge-purple",
  UNKNOWN: "badge-cyan",
}

function Countdown({ mintDate, onLive, isAuto }) {
  const [timeLeft, setTimeLeft] = React.useState("")
  const fired = React.useRef(false)
  React.useEffect(function() {
    function update() {
      const diff = new Date(mintDate) - new Date()
      if (diff <= 0) {
        setTimeLeft("LIVE NOW")
        if (isAuto && !fired.current && onLive) {
          fired.current = true
          onLive()
        }
        return
      }
      fired.current = false
      const d = Math.floor(diff / 86400000)
      const h = Math.floor((diff % 86400000) / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      if (d > 0) setTimeLeft(d + "d " + h + "h " + m + "m")
      else if (h > 0) setTimeLeft(h + "h " + m + "m " + s + "s")
      else setTimeLeft(m + "m " + s + "s")
    }
    update()
    const interval = setInterval(update, 1000)
    return function() { clearInterval(interval) }
  }, [mintDate, isAuto, onLive])
  return React.createElement("span", {
    className: "font-mono text-xs " + (timeLeft === "LIVE NOW" ? "text-green animate-pulse" : "text-accent3")
  }, timeLeft)
}

export default function ProjectCard({ project, isMinting, onMint, onDelete, onStatusUpdate, onMintModeToggle, onEdit }) {
  const [expanded, setExpanded] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [intel, setIntel] = useState(null)
  const [intelLoading, setIntelLoading] = useState(false)
  const status = STATUS_STYLES[project.status] || STATUS_STYLES.upcoming

  const handleFetchIntel = async function() {
    setIntelLoading(true)
    const result = await fetchProjectIntel(project)
    setIntel(result)
    setIntelLoading(false)
    if (result.error) toast.error(result.error)
    else if (result.wl_giveaway_likely) toast.success("WL giveaway likely for " + project.name + "!")
  }

  return (
    <>
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={"card border transition-all " + (project.status === "live" ? "border-green/30 bg-green/3" : project.status === "minted" ? "border-accent/20" : "border-border")}
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
                <span className={"badge " + status.badge + " text-[10px]"}>{status.label}</span>
                <span className={"badge " + (WL_BADGE[project.wl_type] || "badge-cyan") + " text-[10px]"}>{project.wl_type}</span>
                <span className={"badge text-[10px] " + (project.chain === "eth" ? "badge-purple" : "badge-cyan")}>
                  {(project.chain || "eth").toUpperCase()}
                </span>
                {intel && intel.wl_giveaway_likely && (
                  <span className="badge badge-green text-[10px] animate-pulse-slow">WL GIVEAWAY</span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                {project.mint_date && (
                  <div className="flex items-center gap-1.5">
                    <Clock size={11} className="text-muted" />
                    {(project.status === "upcoming" || project.status === "live")
                      ? <Countdown
                    mintDate={project.mint_date}
                    isAuto={project.mint_mode === 'auto' && (project.status === 'upcoming' || project.status === 'live')}
                    onLive={onMint}
                  />
                      : <span className="font-mono text-xs text-muted">{new Date(project.mint_date).toLocaleDateString()}</span>
                    }
                  </div>
                )}
                {project.mint_price && <span className="text-xs text-muted">{project.mint_price}</span>}
                {intel && intel.hype_score && (
                  <span className={"text-xs font-mono " + (intel.hype_score >= 7 ? "text-green" : intel.hype_score >= 4 ? "text-accent3" : "text-muted")}>
                    Hype: {intel.hype_score}/10
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={onMintModeToggle}
                className={"flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-all " + (project.mint_mode === "auto" ? "border-green/40 text-green bg-green/8" : "border-border2 text-muted hover:border-accent hover:text-accent")}
              >
                {project.mint_mode === "auto" ? React.createElement(ToggleRight, { size: 12 }) : React.createElement(ToggleLeft, { size: 12 })}
                {project.mint_mode === "auto" ? "Auto" : "Confirm"}
              </button>
              {(project.status === "live" || project.status === "upcoming") && project.contract_address && (
                <button onClick={onMint} disabled={isMinting} className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5">
                  {isMinting ? React.createElement("div", { className: "spinner w-3 h-3" }) : React.createElement(Zap, { size: 12 })}
                  {isMinting ? "Minting..." : "Mint"}
                </button>
              )}
              <button onClick={function() { setExpanded(!expanded) }} className="text-muted hover:text-text p-1">
                {expanded ? React.createElement(ChevronUp, { size: 14 }) : React.createElement(ChevronDown, { size: 14 })}
              </button>
            </div>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">
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
                  View {React.createElement(ExternalLink, { size: 10 })}
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

          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {React.createElement(Bell, { size: 12, className: "text-accent" })}
                <span className="text-xs font-mono text-muted uppercase tracking-wider">Project Intel</span>
              </div>
              <button onClick={handleFetchIntel} disabled={intelLoading} className="btn-ghost text-xs px-2 py-1 flex items-center gap-1.5">
                {intelLoading ? React.createElement("div", { className: "spinner w-3 h-3" }) : React.createElement(RefreshCw, { size: 11 })}
                {intelLoading ? "Fetching..." : intel ? "Refresh" : "Fetch Intel"}
              </button>
            </div>

            {!intel && !intelLoading && (
              <p className="text-xs text-muted2 italic">Click Fetch Intel for AI analysis - WL giveaway detection, hype score, red flags and tips.</p>
            )}

            {intel && !intel.error && (
              <div className="space-y-2.5">
                {intel.summary && (
                  <p className="text-xs text-text leading-relaxed bg-surface2 rounded-lg p-2.5">{intel.summary}</p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {intel.hype_score && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className={"text-lg font-bold " + (intel.hype_score >= 7 ? "text-green" : intel.hype_score >= 4 ? "text-accent3" : "text-accent2")}>{intel.hype_score}/10</div>
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
                {intel.wl_giveaway_likely && (
                  <div className="bg-green/8 border border-green/20 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      {React.createElement(Gift, { size: 12, className: "text-green" })}
                      <span className="text-xs font-semibold text-green">WL Giveaway Likely</span>
                    </div>
                    <p className="text-xs text-text">{intel.giveaway_note}</p>
                  </div>
                )}
                {intel.red_flags && intel.red_flags.length > 0 && (
                  <div className="bg-accent2/5 border border-accent2/15 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      {React.createElement(AlertCircle, { size: 11, className: "text-accent2" })}
                      <span className="text-[10px] font-mono text-accent2 uppercase tracking-wider">Red Flags</span>
                    </div>
                    {intel.red_flags.map(function(f, i) {
                      return React.createElement("div", { key: i, className: "text-xs text-text flex items-start gap-1.5" },
                        React.createElement("span", { className: "text-accent2 mt-0.5" }, "*"), f)
                    })}
                  </div>
                )}
                {intel.green_flags && intel.green_flags.length > 0 && (
                  <div className="bg-green/5 border border-green/15 rounded-lg p-2.5">
                    <span className="text-[10px] font-mono text-green uppercase tracking-wider">Green Flags</span>
                    {intel.green_flags.map(function(f, i) {
                      return React.createElement("div", { key: i, className: "text-xs text-text flex items-start gap-1.5 mt-1" },
                        React.createElement("span", { className: "text-green mt-0.5" }, "*"), f)
                    })}
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2">
                  {intel.twitter_tip && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">X/Twitter Tip</div>
                      <p className="text-xs text-text">{intel.twitter_tip}</p>
                    </div>
                  )}
                  {intel.discord_tip && (
                    <div className="bg-surface2 rounded-lg p-2.5">
                      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">Discord Tip</div>
                      <p className="text-xs text-text">{intel.discord_tip}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
            {intel && intel.error && (
              <p className="text-xs text-accent2">Error: {intel.error}</p>
            )}
          </div>

          {/* Live Mint Feed */}
          <div className="border-t border-border pt-3 mt-1">
            <LiveMintFeed project={project} />
          </div>


          <div className="flex items-center gap-2 pt-1 flex-wrap border-t border-border">
            <span className="text-xs text-muted">Set status:</span>
            {["upcoming", "live", "minted", "missed", "cancelled"].map(function(s) {
              return React.createElement("button", {
                key: s,
                onClick: function() { onStatusUpdate(s) },
                className: "text-xs px-2 py-0.5 rounded border transition-all " + (project.status === s ? "border-accent text-accent" : "border-border text-muted hover:border-border2")
              }, s)
            })}
            <div className="flex gap-2 ml-auto">
              <button onClick={() => setShowEdit(true)} className="btn-ghost text-xs px-2 py-0.5" style={{borderColor:'rgba(0,255,136,0.4)',color:'var(--accent)'}}>
                Edit
              </button>
              <button onClick={onDelete} className="btn-danger text-xs px-2 py-0.5">
                {React.createElement(Trash2, { size: 11 })}
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>

    {showEdit && (
      <EditProjectModal
        project={project}
        onSave={async (updates) => {
          await onEdit(updates)
          setShowEdit(false)
        }}
        onClose={() => setShowEdit(false)}
      />
    )}
  </>
  )
}
