/**
 * Preflight contract risk checks for Strike execution.
 * Runs before simulation to surface misconfigurations and risks early.
 * Pure sync checks plus optional async on-chain bytecode verification.
 */

// ─── Risk scoring weights ─────────────────────────────────────────────────────

const RISK = {
  NO_CONTRACT:     50,
  ZERO_ADDRESS:    50,
  BAD_ADDRESS:     45,
  NO_CHAIN:        10,
  STALE_INTENT:    30,
  MINT_DATE_OLD:   15,
  EXCESSIVE_SPEND: 20,
  NO_PRICE:         5,
}

// ─── Risk level classification ────────────────────────────────────────────────

export const RISK_LEVELS = {
  SAFE:     'safe',     // 0–10
  LOW:      'low',      // 11–25
  MEDIUM:   'medium',   // 26–50
  HIGH:     'high',     // 51–75
  CRITICAL: 'critical', // 76+
}

export function riskLevel(score) {
  if (score <= 10) return RISK_LEVELS.SAFE
  if (score <= 25) return RISK_LEVELS.LOW
  if (score <= 50) return RISK_LEVELS.MEDIUM
  if (score <= 75) return RISK_LEVELS.HIGH
  return RISK_LEVELS.CRITICAL
}

// ─── Sync preflight ───────────────────────────────────────────────────────────

/**
 * Run synchronous preflight checks on an intent.
 * No network calls — safe to run inline before simulation.
 *
 * @param {object} intent
 * @returns {{ safe: boolean, risk_score: number, risk_level: string, blockers: string[], warnings: string[] }}
 */
export function preflightCheck(intent) {
  const blockers = []
  const warnings = []
  let score = 0

  const contract = intent.contract_address || intent.mint_contract_address || null
  const chain    = intent.chain || null
  const maxSpend = intent.max_total_spend || null
  const mintDate = intent.mint_date || intent.strike_execute_at || null
  const armedAt  = intent.strike_armed_at || intent.created_at || null
  const mintPrice = intent.mint_price ?? intent.value ?? null
  const now = Date.now()

  // ── Contract address ────────────────────────────────────────────────────────
  if (!contract) {
    blockers.push('No contract address configured')
    score += RISK.NO_CONTRACT
  } else if (contract === '0x0000000000000000000000000000000000000000') {
    blockers.push('Contract address is the zero address')
    score += RISK.ZERO_ADDRESS
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    blockers.push(`Contract address format invalid: ${String(contract).slice(0, 12)}…`)
    score += RISK.BAD_ADDRESS
  }

  // ── Chain ───────────────────────────────────────────────────────────────────
  if (!chain) {
    blockers.push('No chain configured')
    score += RISK.NO_CHAIN
  }

  // ── Stale intent ────────────────────────────────────────────────────────────
  if (armedAt) {
    const ageMs = now - new Date(armedAt).getTime()
    if (!Number.isNaN(ageMs) && ageMs > 24 * 3_600_000) {
      const ageH = Math.round(ageMs / 3_600_000)
      warnings.push(`Intent armed ${ageH}h ago — verify still valid`)
      score += RISK.STALE_INTENT
    }
  }

  // ── Mint date too far in the past ───────────────────────────────────────────
  if (mintDate) {
    const pastMs = now - new Date(mintDate).getTime()
    if (!Number.isNaN(pastMs) && pastMs > 2 * 3_600_000) {
      const pastH = Math.round(pastMs / 3_600_000)
      warnings.push(`Mint date was ${pastH}h ago — may be too late to execute`)
      score += RISK.MINT_DATE_OLD
    }
  }

  // ── Excessive spend ─────────────────────────────────────────────────────────
  if (maxSpend !== null && maxSpend !== undefined) {
    const eth = Number(maxSpend)
    if (!Number.isNaN(eth) && eth > 1.0) {
      warnings.push(`Max spend ${eth} ETH is unusually high`)
      score += RISK.EXCESSIVE_SPEND
    }
  }

  // ── Missing mint price ──────────────────────────────────────────────────────
  const priceNum = Number(mintPrice ?? 0)
  if (mintPrice === null || mintPrice === undefined || (priceNum === 0 && mintPrice !== 0 && mintPrice !== '0')) {
    warnings.push('Mint price unset — confirm this is a free mint or price will be detected at runtime')
    score += RISK.NO_PRICE
  }

  return {
    safe: blockers.length === 0,
    risk_score: score,
    risk_level: riskLevel(score),
    blockers,
    warnings,
  }
}

// ─── Async preflight (+ on-chain bytecode check) ──────────────────────────────

/**
 * Async preflight — adds on-chain bytecode verification when publicClient is available.
 * Falls back gracefully if RPC is unavailable.
 *
 * @param {object} intent
 * @param {import('viem').PublicClient|null} publicClient
 * @returns {Promise<ReturnType<preflightCheck> & { on_chain_checked: boolean, bytecode_present: boolean|null }>}
 */
export async function preflightCheckAsync(intent, publicClient = null) {
  const base = preflightCheck(intent)
  let bytecodePresent = null
  let onChainChecked = false

  const contract = intent.contract_address || intent.mint_contract_address
  if (contract && publicClient && base.blockers.every(b => !b.includes('Contract address'))) {
    try {
      const code = await publicClient.getBytecode({ address: contract })
      bytecodePresent = Boolean(code && code !== '0x' && code.length > 2)
      onChainChecked = true
      if (!bytecodePresent) {
        base.blockers.push('Contract has no deployed bytecode on this chain')
        base.safe = false
        base.risk_score += 40
        base.risk_level = riskLevel(base.risk_score)
      }
    } catch {
      base.warnings.push('Could not verify contract bytecode — RPC unavailable')
    }
  }

  return { ...base, on_chain_checked: onChainChecked, bytecode_present: bytecodePresent }
}
