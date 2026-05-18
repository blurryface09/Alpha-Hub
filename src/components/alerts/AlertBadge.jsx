import React from 'react'
import {
  Zap, AlertTriangle, Info, Clock, Package,
  FileCode, X, ArrowRight, Fish, Activity,
} from 'lucide-react'

const TYPE_META = {
  project_live:       { icon: Zap,           label: 'Live',         color: 'text-green',    bg: 'bg-green/10 border-green/25' },
  stealth_delay:      { icon: AlertTriangle,  label: 'Delayed',      color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/25' },
  schedule_changed:   { icon: Clock,          label: 'Schedule',     color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/25' },
  price_changed:      { icon: ArrowRight,     label: 'Price',        color: 'text-accent',   bg: 'bg-accent/10 border-accent/25' },
  supply_changed:     { icon: Package,        label: 'Supply',       color: 'text-accent',   bg: 'bg-accent/10 border-accent/25' },
  contract_deployed:  { icon: FileCode,       label: 'Contract',     color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/25' },
  project_cancelled:  { icon: X,             label: 'Cancelled',    color: 'text-red-400',  bg: 'bg-red-500/10 border-red-500/25' },
  status_changed:     { icon: Info,           label: 'Update',       color: 'text-muted',    bg: 'bg-surface2 border-border' },
  whale_mint:         { icon: Zap,           label: 'Whale Mint',   color: 'text-green',    bg: 'bg-green/10 border-green/25' },
  whale_move:         { icon: Fish,           label: 'Whale Move',   color: 'text-accent',   bg: 'bg-accent/10 border-accent/25' },
  mint_live:          { icon: Zap,           label: 'Live',         color: 'text-green',    bg: 'bg-green/10 border-green/25' },
  mint_success:       { icon: Zap,           label: 'Minted',       color: 'text-green',    bg: 'bg-green/10 border-green/25' },
  mint_failed:        { icon: X,             label: 'Failed',       color: 'text-red-400',  bg: 'bg-red-500/10 border-red-500/25' },
  rug_alert:          { icon: AlertTriangle,  label: 'Rug Alert',    color: 'text-red-400',  bg: 'bg-red-500/10 border-red-500/25' },
  system:             { icon: Activity,       label: 'System',       color: 'text-muted',    bg: 'bg-surface2 border-border' },
}

const SEVERITY_DOT = {
  critical: 'bg-red-500',
  warning:  'bg-amber-500',
  info:     'bg-accent',
}

export function AlertTypeBadge({ type, className = '' }) {
  const meta = TYPE_META[type] || TYPE_META.system
  const Icon = meta.icon
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono
      ${meta.bg} ${meta.color} ${className}`}>
      <Icon size={9} />
      {meta.label}
    </span>
  )
}

export function SeverityDot({ severity, className = '' }) {
  const cls = SEVERITY_DOT[severity] || SEVERITY_DOT.info
  return (
    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cls} ${className}`} />
  )
}

export function getTypeIcon(type) {
  return (TYPE_META[type] || TYPE_META.system).icon
}

export function getTypeColor(type) {
  return (TYPE_META[type] || TYPE_META.system).color
}

export default AlertTypeBadge
