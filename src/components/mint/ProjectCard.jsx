import React, { useState } from "react"
import { motion } from "framer-motion"
import { Zap, Trash2, Clock, ChevronDown, ChevronUp, ToggleLeft, ToggleRight, ExternalLink, RefreshCw, AlertCircle, Gift, Bell } from "lucide-react"
import toast from "react-hot-toast"

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
const GEMINI_FALLBACK_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent"

function getIntelKeyPool() {
  return [
    import.meta.env.VITE_GEMINI_API_KEY,
    import.meta.env.VITE_GEMINI_KEY_2,
    import.meta.env.VITE_GEMINI_KEY_3,
    import.meta.env.VITE_GEMINI_KEY_4,
  ].filter(function(k) { return k && k !== "your_gemini_api_key" && k.startsWith("AIza") })
}

async function fetchProjectIntel(project) {
  const keyPool = getIntelKeyPool()
  if (!keyPool.length) {
    return { error: "No Gemini API key found - add VITE_GEMINI_API_KEY to Vercel environment variables" }
  }

  const prompt = "You are a crypto/NFT project researcher. Research this NFT project and provide intelligence.\n\nProject: " + project.name + "\nSource URL: " + (project.source_url || "unknown") + "\nWL Type: " + project.wl_type + "\nChain: " + project.chain + "\nMint Date: " + (project.mint_date || "not set") + "\nNotes: " + (project.notes || "none") + "\n\nProvide a JSON response (no markdown, no backticks, just raw JSON) with:\n{\n  \"summary\": \"2 sentence description of what this NFT project is\",\n  \"wl_giveaway_likely\": false,\n  \"giveaway_note\": \"\",\n  \"red_flags\": [],\n  \"green_flags\": [],\n  \"hype_score\": 5,\n  \"hype_reason\": \"one sentence why this score\",\n  \"advice\": \"one sharp sentence - should they mint or skip?\",\n  \"discord_tip\": \"what channels/roles to check to confirm WL\",\n  \"twitter_tip\": \"exact search terms to find WL giveaways for this project on X\"\n}"

  let keyIndex = 0
  const totalAttempts = keyPool.length * 3

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const key = keyPool[keyIndex % keyPool.length]
    keyIndex++
    try {
      const r = await fetch(GEMINI_URL + "?key=" + key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        })
      })
      const d = await r.json()
      if (d.error) {
        if (d.error.code === 429 || d.error.status === "RESOURCE_EXHAUSTED") {
          continue
        }
        return { error: d.error.message }
      }
      const text = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] ? d.candidates[0].content.parts[0].text : ""
      const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
      const match = clean.match(/\{[\s\S]*\}/)
      if (match) {
        try { return JSON.parse(match[0]) } catch(e) { return { error: "Parse failed - try again" } }
      }
      return { error: "Invalid response - try again" }
    } catch(e) {
      if (attempt < totalAttempts - 1) {
        await new Promise(function(res) { setTimeout(res, 1000) })
        continue
      }
      return { error: e.message }
    }
  }
  return { error: "All keys rate limited - wait 1 minute and try again" }
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

function Countdown({ mintDate }) {
  const [timeLeft, setTimeLeft] = React.useState("")
  React.useEffect(function() {
    function update() {
      const diff = new Date(mintDate) - new Date()
      if (diff <= 0) { setTimeLeft("LIVE NOW"); return }
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
  }, [mintDate])
  return React.createElement("span", { className: "font-mono text-xs text-accent3" }, timeLeft)
}

export default function ProjectCard({ project, isMinting, onMint, onDelete, onStatusUpdate, onMintModeToggle }) {
  const [expanded, setExpanded] = useState(false)
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
                    {project.status === "upcoming"
                      ? <Countdown mintDate={project.mint_date} />
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

          <div className="flex items-center gap-2 pt-1 flex-wrap border-t border-border">
            <span className="text-xs text-muted">Set status:</span>
            {["upcoming", "live", "minted", "missed", "cancelled"].map(function(s) {
              return React.createElement("button", {
                key: s,
                onClick: function() { onStatusUpdate(s) },
                className: "text-xs px-2 py-0.5 rounded border transition-all " + (project.status === s ? "border-accent text-accent" : "border-border text-muted hover:border-border2")
              }, s)
            })}
            <button onClick={onDelete} className="btn-danger ml-auto text-xs px-2 py-0.5">
              {React.createElement(Trash2, { size: 11 })}
            </button>
          </div>
        </div>
      )}
    </motion.div>
  )
}
