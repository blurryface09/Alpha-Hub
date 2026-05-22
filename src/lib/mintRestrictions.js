// Canonical restriction states, messages, and UI logic for all app surfaces.
// Server (mint-engine) and client (useMint, CalendarPage, ProjectCard, StrikeReviewModal)
// must all resolve restriction copy from here.

export const RESTRICTION_MESSAGES = {
  live:                  null,
  not_probed:            null,
  // Capability states (prepared_execution_status)
  public_live:           null,
  waiting_public_drop:   'Execution path ready — waiting for public mint to open.',
  ready:                 null,
  unsupported_contract:  'Execution not supported — use the official mint site.',
  // Allowlist states
  allowlist_ready:       null,  // wallet has proof, can execute
  proof_unavailable:     'Wallet may be eligible, but the allowlist proof is only available through the official mint page.',
  wallet_not_eligible:   'This wallet is not on the allowlist for this mint.',
  // Execution states
  public_not_started:    'Public mint has not started yet.',
  not_started:           'Public mint has not started yet.',
  allowlist_only:        'This mint is allowlist-only — public mint has not opened. Check the official page for your allowlist proof.',
  signed_mint_only:      'Proof requires OpenSea session. Use official mint.',
  sold_out:              'Mint has sold out.',
  paused:                'Contract is paused.',
  router_required:       'Minting via a router — use the official mint page.',
  proof_required:        'Allowlist proof required — obtain from the official mint site.',
  captcha_required:      'CAPTCHA required — must mint via the official page.',
  unsupported_execution: 'Execution not supported — use the official mint site.',
  wrong_function:        'Mint function not detected yet.',
  error:                 'Execution check failed — retry in a moment.',
}

// States where Alpha Hub cannot execute the mint for this wallet
export const EXECUTION_BLOCKED = new Set([
  'allowlist_only', 'signed_mint_only', 'sold_out', 'paused',
  'router_required', 'wallet_not_eligible', 'proof_required',
  'proof_unavailable', 'captcha_required', 'unsupported_execution', 'unsupported_contract',
])
// States that confirm allowlist IS active (contract is live, just access-gated)
export const ALLOWLIST_ACTIVE = new Set(['allowlist_ready', 'proof_unavailable', 'wallet_not_eligible', 'signed_mint_only'])

// Capability states where Strike can be pre-armed (execution path known, mint not yet open)
export const PRE_ARM_ALLOWED = new Set(['waiting_public_drop', 'ready', 'public_live'])

// States that confirm the project IS live on-chain (regardless of executability)
export const LIVE_EXECUTION_STATUSES = new Set([
  'live', 'allowlist_only', 'signed_mint_only', 'sold_out',
])

export function restrictionMessage(status) {
  return RESTRICTION_MESSAGES[status] ?? null
}

export function isExecutionBlocked(status) {
  return EXECUTION_BLOCKED.has(status)
}

// Returns the best CTA action for a given restriction state
// 'mint' = Alpha Hub can execute | 'wait' = not open yet | 'open_official' = restricted
export function restrictionCta(status) {
  if (!status || status === 'live' || status === 'not_probed' || status === 'public_live' || status === 'ready' || status === 'allowlist_ready') return 'mint'
  if (status === 'not_started' || status === 'public_not_started' || status === 'waiting_public_drop') return 'wait'
  return 'open_official'
}

export function isPreArmAllowed(preparedStatus) {
  return PRE_ARM_ALLOWED.has(preparedStatus)
}
