export const MINT_PHASES = [
  { id: 'gtd', label: 'GTD', copy: 'Guaranteed spot', recommendedMode: 'safe' },
  { id: 'wl', label: 'WL', copy: 'Allowlist mint', recommendedMode: 'safe' },
  { id: 'wl_fcfs', label: 'FCFS WL', copy: 'Allowlist, first come first served', recommendedMode: 'fast' },
  { id: 'public', label: 'Public', copy: 'Open public mint', recommendedMode: 'safe' },
  { id: 'public_fcfs', label: 'Public FCFS', copy: 'Fast public mint window', recommendedMode: 'strike' },
  { id: 'open_edition', label: 'Open Edition', copy: 'Timed edition or open claim', recommendedMode: 'fast' },
  { id: 'claim', label: 'Claim', copy: 'Claim or free/eligible mint', recommendedMode: 'safe' },
  { id: 'unknown', label: 'Not sure', copy: 'Alpha Hub will stay conservative', recommendedMode: 'safe' },
]

export const MINT_MODES = {
  safe: {
    id: 'safe',
    label: 'Safe Mint',
    shortLabel: 'Safe',
    copy: 'You confirm with your connected wallet. Safest and default.',
  },
  fast: {
    id: 'fast',
    label: 'Fast Mint',
    shortLabel: 'Fast',
    copy: 'Alpha Hub prepares the transaction so wallet confirmation is faster.',
  },
  strike: {
    id: 'strike',
    label: 'Strike Mode',
    shortLabel: 'Strike',
    copy: 'Auto execution through Alpha Vault with strict limits and simulation.',
  },
}

export const LIVE_MINT_STATES = [
  'Preparing project',
  'Detecting phase',
  'Checking contract',
  'Preparing transaction',
  'Simulating mint',
  'Gas locked',
  'Watching mint window',
  'Mint live',
  'Broadcasting transaction',
  'Waiting confirmation',
  'Minted',
  'Failed',
  'Stopped',
]

export function normalizeMintPhase(value) {
  const text = String(value || '').toLowerCase().replace(/[\s-]+/g, '_')
  if (text.includes('gtd') || text.includes('guaranteed')) return 'gtd'
  if (text.includes('wl_fcfs') || (text.includes('wl') && text.includes('fcfs'))) return 'wl_fcfs'
  if (text.includes('public_fcfs') || (text.includes('public') && text.includes('fcfs'))) return 'public_fcfs'
  if (text.includes('allow') || text === 'wl' || text.includes('whitelist')) return 'wl'
  if (text.includes('open') || text.includes('edition')) return 'open_edition'
  if (text.includes('claim')) return 'claim'
  if (text.includes('public')) return 'public'
  return 'unknown'
}

export function recommendMintMode(phase, risk = 50) {
  const normalized = normalizeMintPhase(phase)
  if (risk >= 70 || normalized === 'unknown') return 'safe'
  const found = MINT_PHASES.find(item => item.id === normalized)
  return found?.recommendedMode || 'safe'
}
