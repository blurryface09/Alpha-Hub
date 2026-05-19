/**
 * Wallet Intelligence — pure functions for conviction scoring and alert detection.
 * No DB calls. All inputs are plain objects from the cron sweep.
 */

// ── Alert types ───────────────────────────────────────────────────────────────

export const WALLET_ALERT_TYPES = {
  WALLET_ENTRY:       'wallet_entry',        // followed wallet minted project you track
  WALLET_REPEAT_MINT: 'wallet_repeat_mint',  // wallet minted same contract >once
  WALLET_LARGE_MINT:  'wallet_large_mint',   // high-value mint from followed wallet
}

// ── Conviction scoring ────────────────────────────────────────────────────────

/**
 * Compute 0-100 conviction score from a wallet's aggregate activity.
 *
 * @param {{ total_mints: number, unique_contracts: number, large_mints: number, repeat_mints: number }} profile
 * @returns {number} 0-100
 */
export function scoreConviction({ total_mints = 0, unique_contracts = 0, large_mints = 0, repeat_mints = 0 }) {
  // Volume: up to 25 pts (caps at 25 mints)
  const volume = Math.min(total_mints * 1, 25)
  // Breadth: up to 20 pts (unique project diversity)
  const breadth = Math.min(unique_contracts * 2, 20)
  // Size: up to 25 pts (large mints signal conviction)
  const size = Math.min(large_mints * 5, 25)
  // Repeat conviction: up to 30 pts (repeat minting = strong signal)
  const repeat = total_mints > 0 ? Math.min((repeat_mints / total_mints) * 30, 30) : 0
  return Math.round(volume + breadth + size + repeat)
}

/**
 * Derive a wallet profile aggregate from an array of whale_activity rows.
 *
 * @param {object[]} activities - whale_activity rows for this wallet
 * @returns {{ total_mints, unique_contracts, large_mints, repeat_mints, conviction_score, first_seen_at, last_active_at }}
 */
export function buildWalletProfile(activities) {
  if (!activities?.length) return { total_mints: 0, unique_contracts: 0, large_mints: 0, repeat_mints: 0, conviction_score: 0 }

  const mints = activities.filter(a => a.is_mint)
  const contractCounts = {}
  for (const a of mints) {
    if (a.contract_address) contractCounts[a.contract_address] = (contractCounts[a.contract_address] || 0) + 1
  }

  const total_mints      = mints.length
  const unique_contracts = Object.keys(contractCounts).length
  const large_mints      = mints.filter(a => parseFloat(a.value_eth || 0) >= 0.5).length
  const repeat_mints     = Object.values(contractCounts).filter(c => c > 1).length

  const timestamps = activities.map(a => a.timestamp).filter(Boolean).sort()
  const first_seen_at  = timestamps[0]   || null
  const last_active_at = timestamps[timestamps.length - 1] || null

  return {
    total_mints,
    unique_contracts,
    large_mints,
    repeat_mints,
    conviction_score: scoreConviction({ total_mints, unique_contracts, large_mints, repeat_mints }),
    first_seen_at,
    last_active_at,
  }
}

// ── Alert detection ───────────────────────────────────────────────────────────

/**
 * Detect a large-mint alert from a single activity row.
 * Threshold: 0.5 ETH.
 *
 * @param {object} activity - whale_activity row
 * @returns {object|null} alert payload or null
 */
export function detectLargeMint(activity) {
  if (!activity.is_mint) return null
  if (parseFloat(activity.value_eth || 0) < 0.5) return null
  return {
    type:     WALLET_ALERT_TYPES.WALLET_LARGE_MINT,
    severity: 'warning',
    dedupKey: `wallet_large_mint:${activity.wallet_address}:${activity.tx_hash || activity.id}`,
    title:    `Large mint: ${shortAddr(activity.wallet_address)}`,
    message:  `${parseFloat(activity.value_eth).toFixed(3)} ${activity.chain?.toUpperCase() || 'ETH'} — ${activity.method_name || 'mint'}`,
    data: {
      wallet_address:   activity.wallet_address,
      contract_address: activity.contract_address,
      tx_hash:          activity.tx_hash,
      value_eth:        activity.value_eth,
      chain:            activity.chain,
    },
  }
}

/**
 * Detect a repeat-mint alert when a wallet mints the same contract again.
 *
 * @param {object} activity - the new whale_activity row
 * @param {boolean} hasPrior - whether a prior mint to this contract exists
 * @returns {object|null}
 */
export function detectRepeatMint(activity, hasPrior) {
  if (!activity.is_mint || !activity.contract_address || !hasPrior) return null
  return {
    type:     WALLET_ALERT_TYPES.WALLET_REPEAT_MINT,
    severity: 'warning',
    dedupKey: `wallet_repeat_mint:${activity.wallet_address}:${activity.contract_address}`,
    title:    `Repeat mint: ${shortAddr(activity.wallet_address)}`,
    message:  `Minted the same contract again — strong conviction signal`,
    data: {
      wallet_address:   activity.wallet_address,
      contract_address: activity.contract_address,
      chain:            activity.chain,
    },
  }
}

/**
 * Detect a wallet-entry alert when a followed wallet mints a project the user tracks.
 *
 * @param {object} activity - whale_activity row
 * @param {string} projectName - matching wl_project name
 * @returns {object|null}
 */
export function detectWalletEntry(activity, projectName) {
  if (!activity.is_mint || !activity.contract_address) return null
  return {
    type:     WALLET_ALERT_TYPES.WALLET_ENTRY,
    severity: 'critical',
    dedupKey: `wallet_entry:${activity.wallet_address}:${activity.contract_address}`,
    title:    `Whale entered: ${projectName}`,
    message:  `${shortAddr(activity.wallet_address)} just minted — ${parseFloat(activity.value_eth || 0).toFixed(3)} ETH`,
    data: {
      wallet_address:   activity.wallet_address,
      contract_address: activity.contract_address,
      project_name:     projectName,
      chain:            activity.chain,
    },
  }
}

// ── Conviction label ──────────────────────────────────────────────────────────

export function convictionLabel(score) {
  if (score >= 80) return 'Elite'
  if (score >= 60) return 'Strong'
  if (score >= 40) return 'Active'
  if (score >= 20) return 'Emerging'
  return 'New'
}

export function convictionColor(score) {
  if (score >= 80) return 'text-green'
  if (score >= 60) return 'text-accent'
  if (score >= 40) return 'text-accent3'
  if (score >= 20) return 'text-amber-400'
  return 'text-muted'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr) {
  if (!addr) return '?'
  return addr.slice(0, 8) + '…' + addr.slice(-4)
}
