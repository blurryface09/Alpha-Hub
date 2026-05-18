/**
 * Mint pattern classification and execution strategy auto-selection.
 * Classifies a mint as FCFS / Dutch / Raffle / Staged / Unknown from intent signals,
 * then recommends optimal gas strategy, timing offset, and retry policy.
 */

// ─── Pattern constants ────────────────────────────────────────────────────────

export const MINT_PATTERNS = {
  FCFS:    'fcfs',    // First-come-first-served: timing + gas critical
  DUTCH:   'dutch',   // Dutch auction: price decreases over time
  RAFFLE:  'raffle',  // Random selection: timing flexible
  STAGED:  'staged',  // Multi-phase: allowlist → public
  UNKNOWN: 'unknown',
}

export const EXECUTION_STRATEGIES = {
  SPEED_FIRST:     'speed_first',     // Max gas, fire early (FCFS)
  COST_OPTIMIZED:  'cost_optimized',  // Wait for price drop (Dutch)
  RELAXED:         'relaxed',         // Safe gas, flexible timing (Raffle)
  PHASED:          'phased',          // Stage-aware execution
  DEFAULT:         'default',         // Balanced baseline
}

// ─── Signal tables ────────────────────────────────────────────────────────────

const FN_SIGNALS = [
  // [normalized-fn-name, pattern, weight]
  ['mint',             MINT_PATTERNS.FCFS,   3],
  ['publicmint',       MINT_PATTERNS.FCFS,   4],
  ['mintpublic',       MINT_PATTERNS.FCFS,   4],
  ['safemint',         MINT_PATTERNS.FCFS,   3],
  ['claim',            MINT_PATTERNS.FCFS,   3],
  ['buy',              MINT_PATTERNS.FCFS,   2],
  ['purchase',         MINT_PATTERNS.DUTCH,  4],
  ['mintdutch',        MINT_PATTERNS.DUTCH,  5],
  ['buynft',           MINT_PATTERNS.DUTCH,  3],
  ['enterraffle',      MINT_PATTERNS.RAFFLE, 6],
  ['joinraffle',       MINT_PATTERNS.RAFFLE, 6],
  ['register',         MINT_PATTERNS.RAFFLE, 3],
  ['enter',            MINT_PATTERNS.RAFFLE, 2],
  ['allowlistmint',    MINT_PATTERNS.STAGED, 5],
  ['presalemint',      MINT_PATTERNS.STAGED, 5],
  ['whitelistmint',    MINT_PATTERNS.STAGED, 5],
  ['mintstage',        MINT_PATTERNS.STAGED, 4],
]

const KEYWORD_SIGNALS = [
  // [keyword, pattern, weight]
  ['dutch',      MINT_PATTERNS.DUTCH,  3],
  ['auction',    MINT_PATTERNS.DUTCH,  3],
  ['descending', MINT_PATTERNS.DUTCH,  2],
  ['raffle',     MINT_PATTERNS.RAFFLE, 4],
  ['lottery',    MINT_PATTERNS.RAFFLE, 4],
  ['random',     MINT_PATTERNS.RAFFLE, 2],
  ['lucky',      MINT_PATTERNS.RAFFLE, 1],
  ['stage',      MINT_PATTERNS.STAGED, 2],
  ['phase',      MINT_PATTERNS.STAGED, 2],
  ['allowlist',  MINT_PATTERNS.STAGED, 3],
  ['whitelist',  MINT_PATTERNS.STAGED, 2],
  ['presale',    MINT_PATTERNS.STAGED, 3],
]

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Classify the mint pattern from intent data.
 *
 * @param {object} intent
 * @param {string|null} [functionName]  — ABI-resolved function name (from prepareMintTransaction)
 * @returns {{ pattern: string, confidence: number, signals: string[] }}
 */
export function classifyMintPattern(intent, functionName = null) {
  const scores = {
    [MINT_PATTERNS.FCFS]:   0,
    [MINT_PATTERNS.DUTCH]:  0,
    [MINT_PATTERNS.RAFFLE]: 0,
    [MINT_PATTERNS.STAGED]: 0,
  }
  const signals = []

  const fnNorm = String(functionName || '').toLowerCase().replace(/[^a-z]/g, '')
  const corpus = [
    intent.name, intent.project_name, intent.description,
  ].filter(Boolean).join(' ').toLowerCase()

  // Function name signals
  for (const [fn, pat, w] of FN_SIGNALS) {
    if (fnNorm === fn) {
      scores[pat] += w
      signals.push(`fn:${fn}→${pat}(${w})`)
      break // first match wins for function name
    }
  }

  // Keyword signals from name/description
  for (const [kw, pat, w] of KEYWORD_SIGNALS) {
    if (corpus.includes(kw)) {
      scores[pat] += w
      signals.push(`kw:${kw}→${pat}(${w})`)
    }
  }

  // Structural signals
  if (intent.mint_date || intent.strike_execute_at) {
    scores[MINT_PATTERNS.FCFS] += 1
    signals.push('has_mint_date→fcfs(1)')
  }
  if (Number(intent.mint_price || 0) === 0) {
    scores[MINT_PATTERNS.FCFS] += 1
    signals.push('free_mint→fcfs(1)')
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0)
  if (total === 0) return { pattern: MINT_PATTERNS.UNKNOWN, confidence: 0, signals }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [topPattern, topScore] = ranked[0]
  const [, secondScore] = ranked[1] ?? ['', 0]

  const confidence = Math.round((topScore / total) * 100)

  // Require clear winner: ≥40% confidence and at least 2 points ahead
  if (confidence < 40 || topScore - secondScore < 2) {
    return { pattern: MINT_PATTERNS.UNKNOWN, confidence, signals }
  }

  return { pattern: topPattern, confidence, signals }
}

// ─── Strategy selection ───────────────────────────────────────────────────────

/**
 * Select an execution strategy based on mint pattern and network congestion.
 *
 * @param {string} pattern
 * @param {{ congestionLevel?: 'low'|'medium'|'high'|'extreme' }} [networkContext]
 * @returns {{
 *   strategy: string,
 *   gas_strategy: 'safe'|'balanced'|'aggressive',
 *   execution_offset_ms: number,
 *   max_retries: number,
 *   description: string,
 * }}
 */
export function selectExecutionStrategy(pattern, networkContext = {}) {
  const congestion = networkContext.congestionLevel ?? 'medium'
  const highCongestion = congestion === 'high' || congestion === 'extreme'

  switch (pattern) {
    case MINT_PATTERNS.FCFS:
      return {
        strategy: EXECUTION_STRATEGIES.SPEED_FIRST,
        gas_strategy: 'aggressive',
        execution_offset_ms: -500,
        max_retries: 3,
        description: 'FCFS: aggressive gas, fire 500ms early for speed advantage',
      }

    case MINT_PATTERNS.DUTCH:
      return {
        strategy: EXECUTION_STRATEGIES.COST_OPTIMIZED,
        gas_strategy: highCongestion ? 'balanced' : 'safe',
        execution_offset_ms: 2_000,
        max_retries: 2,
        description: 'Dutch: cost-optimized gas, slight delay for price discovery',
      }

    case MINT_PATTERNS.RAFFLE:
      return {
        strategy: EXECUTION_STRATEGIES.RELAXED,
        gas_strategy: 'safe',
        execution_offset_ms: 0,
        max_retries: 2,
        description: 'Raffle: safe gas, timing flexible — entry is what matters',
      }

    case MINT_PATTERNS.STAGED:
      return {
        strategy: EXECUTION_STRATEGIES.PHASED,
        gas_strategy: highCongestion ? 'aggressive' : 'balanced',
        execution_offset_ms: -1_000,
        max_retries: 3,
        description: 'Staged: phase-aware, balanced gas, fire slightly early',
      }

    default:
      return {
        strategy: EXECUTION_STRATEGIES.DEFAULT,
        gas_strategy: highCongestion ? 'aggressive' : 'balanced',
        execution_offset_ms: 0,
        max_retries: 3,
        description: 'Unknown pattern: balanced defaults',
      }
  }
}
