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

  /** Enable real transaction broadcasting on Sepolia / Base Sepolia ONLY */
  TESTNET_EXECUTION_ENABLED: parseBool('TESTNET_EXECUTION_ENABLED', false),

  /** Run preflight contract risk checks before simulation */
  PREFLIGHT_ENABLED: parseBool('PREFLIGHT_ENABLED', true),

  /** Classify mint patterns and auto-select execution strategy */
  PATTERN_CLASSIFICATION_ENABLED: parseBool('PATTERN_CLASSIFICATION_ENABLED', true),

  /** Use congestion-adaptive gas escalation multipliers */
  ADAPTIVE_GAS_ENABLED: parseBool('ADAPTIVE_GAS_ENABLED', true),

  /** Emit execution profiling telemetry events */
  EXECUTION_TELEMETRY_ENABLED: parseBool('EXECUTION_TELEMETRY_ENABLED', true),

  /** Prevent double-submission by checking for existing tx_hash / confirmed attempts */
  DUPLICATE_PREVENTION_ENABLED: parseBool('DUPLICATE_PREVENTION_ENABLED', true),

  /** Enforce CONTRACT_ALLOWLIST env var — reject executions for non-listed contracts */
  CONTRACT_ALLOWLIST_ENABLED: parseBool('CONTRACT_ALLOWLIST_ENABLED', false),

  /** Run eth_call simulation before every broadcast */
  PRE_BROADCAST_SIMULATION_ENABLED: parseBool('PRE_BROADCAST_SIMULATION_ENABLED', false),

  /** Periodically sweep and recover orphaned executing intents */
  ORPHAN_RECOVERY_ENABLED: parseBool('ORPHAN_RECOVERY_ENABLED', true),

  // OPS-2: Default true — without leases a second Railway replica will poll and
  // execute the same intents concurrently, causing nonce collisions and duplicate
  // broadcasts. Operators must explicitly disable if they know they're single-replica.
  /** Advisory single-worker coordination via DB heartbeat leases */
  LEASE_ENABLED: parseBool('LEASE_ENABLED', true),

  /** Enforce max_total_spend cap on each transaction value */
  SPEND_CAP_ENABLED: parseBool('SPEND_CAP_ENABLED', true),

  /** Enable background project revalidation and alert engine */
  MONITORING_ENABLED: parseBool('MONITORING_ENABLED', true),

  /** Route FCFS intent broadcasts via Base sequencer / Flashbots instead of public mempool */
  PRIVATE_SUBMIT_ENABLED: parseBool('PRIVATE_SUBMIT_ENABLED', false),
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
