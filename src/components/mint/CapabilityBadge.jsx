import React from 'react'
import { Zap, Clock, Shield, ExternalLink, Globe, X, Database, HelpCircle } from 'lucide-react'

/**
 * Unified capability status badge.
 * Maps prepared_execution_status → one of 6 clear user-facing states.
 *
 * Props:
 *   status     — prepared_execution_status string
 *   hasProfile — whether a capture profile exists for this contract
 *   compact    — small pill vs. full row badge
 *   className  — extra classes
 */

const STATES = {
  // Captured profile — execution path learned from official mint
  captured_ready:   {
    label: 'Profile Captured',
    Icon: Database,
    cls: 'border-purple-500/40 text-purple-300 bg-purple-500/8',
    tip: 'Execution path learned from official mint — Strike pre-armed with real calldata',
  },
  // Alpha Hub can execute directly
  live:             { label: 'Alpha Mint Ready', Icon: Zap,         cls: 'border-green/40 text-green bg-green/8',           tip: 'Contract live — Alpha Hub can execute'             },
  ready:            { label: 'Alpha Mint Ready', Icon: Zap,         cls: 'border-green/40 text-green bg-green/8',           tip: 'Execution path verified — ready to mint'           },
  public_live:      { label: 'Alpha Mint Ready', Icon: Zap,         cls: 'border-green/40 text-green bg-green/8',           tip: 'Public drop live — Alpha Hub can execute'          },
  // Allowlist wallet ready
  allowlist_ready:  { label: 'Allowlist Ready',  Icon: Shield,      cls: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/8',  tip: 'Allowlist proof found — wallet eligible'           },
  // Pre-armed, waiting
  waiting_public_drop: { label: 'Waiting Drop',  Icon: Clock,       cls: 'border-amber-500/40 text-amber-300 bg-amber-500/8', tip: 'Execution path ready — waiting for mint to open' },
  // OpenSea session required
  signed_mint_only: { label: 'Session Required', Icon: ExternalLink, cls: 'border-orange-500/40 text-orange-300 bg-orange-500/8', tip: 'Proof requires OpenSea session — use official page' },
  // Must use official mint page
  proof_unavailable:    { label: 'Official Mint', Icon: Globe, cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'Proof only available through official mint page'    },
  allowlist_only:       { label: 'Official Mint', Icon: Globe, cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'Allowlist only — check official page for your proof' },
  proof_required:       { label: 'Official Mint', Icon: Globe, cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'Proof required — obtain from official mint site'    },
  router_required:      { label: 'Official Mint', Icon: Globe, cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'Router required — use official mint page'           },
  captcha_required:     { label: 'Official Mint', Icon: Globe, cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'CAPTCHA required — must mint via official page'     },
  unsupported_execution:{ label: 'Official Mint', Icon: Globe, cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'Execution not supported — use official mint site'   },
  // Wallet not eligible
  wallet_not_eligible:  { label: 'Not Eligible',  Icon: X,    cls: 'border-red-500/30 text-red-400 bg-red-500/5', tip: 'This wallet is not on the allowlist for this mint'  },
  // Unsupported
  unsupported_contract: { label: 'Unsupported',   Icon: X,    cls: 'border-border2 text-muted2 bg-transparent',   tip: 'Contract not supported for Alpha Hub execution'    },
  wrong_function:       { label: 'Unsupported',   Icon: X,    cls: 'border-border2 text-muted2 bg-transparent',   tip: 'Mint function not detected — try re-probing'        },
  error:                { label: 'Probe Error',   Icon: HelpCircle, cls: 'border-border2 text-muted2 bg-transparent', tip: 'Execution check failed — retry simulation'      },
}

/**
 * Resolve the effective status, promoting to captured_ready when a profile
 * exists and no strong restriction is active.
 */
function resolveStatus(status, hasProfile) {
  if (hasProfile) {
    const blockedStates = new Set(['signed_mint_only', 'wallet_not_eligible', 'unsupported_contract', 'unsupported_execution', 'router_required', 'captcha_required'])
    if (!status || status === 'not_probed' || !blockedStates.has(status)) {
      return 'captured_ready'
    }
  }
  return status
}

export default function CapabilityBadge({ status, hasProfile = false, compact = false, className = '' }) {
  const effectiveStatus = resolveStatus(status, hasProfile)
  const state = STATES[effectiveStatus]
  if (!state) return null

  const { label, Icon, cls, tip } = state

  if (compact) {
    return (
      <span
        title={tip}
        className={`badge text-[10px] border flex items-center gap-0.5 ${cls} ${className}`}
      >
        <Icon size={9} />
        {label}
      </span>
    )
  }

  return (
    <div
      title={tip}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs ${cls} ${className}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="font-medium">{label}</span>
    </div>
  )
}

/**
 * Inline version without background fill — for use inside rows.
 */
export function CapabilityLabel({ status, hasProfile = false }) {
  const effectiveStatus = resolveStatus(status, hasProfile)
  const state = STATES[effectiveStatus]
  if (!state) return <span className="text-muted text-xs">—</span>
  const { label, Icon, cls } = state
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${cls.split(' ').filter(c => c.startsWith('text-')).join(' ')}`}>
      <Icon size={10} />
      {label}
    </span>
  )
}
