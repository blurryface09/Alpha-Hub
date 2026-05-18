/**
 * Feature flag system sourced from environment variables.
 * All flags default to safe values — live execution is off by default.
 */

function parseBool(envKey, defaultValue) {
  const val = process.env[envKey]
  if (val === undefined || val === '') return defaultValue
  return val.toLowerCase() === 'true'
}

export const FLAGS = {
  /** Master gate: no transactions are sent unless this is true */
  LIVE_EXECUTION_ENABLED: parseBool('LIVE_EXECUTION_ENABLED', false),

  /** Enable automatic retry on transient failures */
  RETRY_ENABLED: parseBool('RETRY_ENABLED', true),

  /** Enable loading multiple vault wallets and round-robin rotation */
  MULTI_WALLET_ENABLED: parseBool('MULTI_WALLET_ENABLED', false),

  /** Enable gas escalation on each retry attempt */
  GAS_ESCALATION_ENABLED: parseBool('GAS_ESCALATION_ENABLED', true),

  /** Enable prewarm phase: prepare wallet/gas before mint_execute_at window */
  PREWARM_ENABLED: parseBool('PREWARM_ENABLED', true),

  /** Enable latency-based RPC health scoring and ordered failover */
  RPC_HEALTH_SCORING_ENABLED: parseBool('RPC_HEALTH_SCORING_ENABLED', true),

  /** Log what would execute even when LIVE_EXECUTION_ENABLED=false */
  DRY_RUN_LOGGING: parseBool('DRY_RUN_LOGGING', true),

  /** Run full execution path against the mint adapter without touching the blockchain */
  SIMULATION_MODE: parseBool('SIMULATION_MODE', false),
}

/**
 * Check whether a named feature flag is enabled.
 * @param {keyof typeof FLAGS} name
 * @returns {boolean}
 */
export function flagEnabled(name) {
  if (!(name in FLAGS)) {
    console.warn(`[flags] Unknown flag: ${name}`)
    return false
  }
  return Boolean(FLAGS[name])
}
