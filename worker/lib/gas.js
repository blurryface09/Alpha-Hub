/**
 * Gas strategy abstraction for EIP-1559 and legacy chains.
 * Supports safe / balanced / aggressive strategies plus escalation for retries.
 */

import { log as globalLog } from './logger.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const GWEI = 1_000_000_000n

/** Priority fee (tip) per strategy in gwei */
const STRATEGY_PRIORITY_FEE_GWEI = {
  safe: 1.0,
  balanced: 1.5,
  aggressive: 3.0,
}

/** baseFee multiplier per strategy */
const STRATEGY_BASE_MULTIPLIER = {
  safe: 1.5,
  balanced: 2.0,
  aggressive: 2.5,
}

/** Legacy gasPrice multiplier per strategy */
const STRATEGY_GAS_PRICE_MULTIPLIER = {
  safe: 1.1,
  balanced: 1.3,
  aggressive: 1.6,
}

/** Escalation multiplier applied per retry attempt (must be >= 1.10 per EIP-1559 replacement rules) */
const ESCALATION_MULTIPLIER = 1.25

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gweiToBigInt(gwei) {
  // Accept floats by rounding to nearest integer wei
  return BigInt(Math.round(gwei * 1e9))
}

function bigIntToGwei(wei) {
  return Number(wei) / 1e9
}

function applyEscalation(value, retryAttempt) {
  if (retryAttempt <= 0) return value
  const multiplier = ESCALATION_MULTIPLIER ** retryAttempt
  // Multiply as float then convert back to BigInt
  return BigInt(Math.ceil(Number(value) * multiplier))
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Estimate gas parameters for a transaction.
 *
 * @param {import('viem').PublicClient} publicClient
 * @param {'safe'|'balanced'|'aggressive'} strategy
 * @param {number} retryAttempt  — 0 for first attempt
 * @returns {Promise<{
 *   maxFeePerGas: bigint|undefined,
 *   maxPriorityFeePerGas: bigint|undefined,
 *   gasPrice: bigint|undefined,
 *   isEip1559: boolean,
 *   strategy: string,
 *   baseFeeGwei: number|null,
 * }>}
 */
export async function estimateGas(publicClient, strategy = 'balanced', retryAttempt = 0) {
  const normalised = ['safe', 'balanced', 'aggressive'].includes(strategy)
    ? strategy
    : 'balanced'

  let block
  try {
    block = await publicClient.getBlock({ blockTag: 'latest' })
  } catch (err) {
    globalLog.warn('gas', 'Failed to fetch latest block for gas estimation', { error: err.message })
    block = null
  }

  const baseFee = block?.baseFeePerGas ?? null
  const isEip1559 = baseFee !== null

  if (isEip1559) {
    const priorityFeeGwei = STRATEGY_PRIORITY_FEE_GWEI[normalised]
    const baseMultiplier = STRATEGY_BASE_MULTIPLIER[normalised]

    const priorityFeeWei = gweiToBigInt(priorityFeeGwei)
    // maxFee = baseFee * multiplier + priorityFee
    const scaledBase = BigInt(Math.ceil(Number(baseFee) * baseMultiplier))
    const rawMaxFee = scaledBase + priorityFeeWei

    const maxPriorityFeePerGas = applyEscalation(priorityFeeWei, retryAttempt)
    const maxFeePerGas = applyEscalation(rawMaxFee, retryAttempt)

    globalLog.debug('gas', 'EIP-1559 gas estimate', {
      strategy: normalised,
      retry_attempt: retryAttempt,
      base_fee_gwei: bigIntToGwei(baseFee).toFixed(4),
      max_priority_fee_gwei: bigIntToGwei(maxPriorityFeePerGas).toFixed(4),
      max_fee_gwei: bigIntToGwei(maxFeePerGas).toFixed(4),
    })

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasPrice: undefined,
      isEip1559: true,
      strategy: normalised,
      baseFeeGwei: bigIntToGwei(baseFee),
    }
  }

  // Legacy fallback: use gasPrice * multiplier
  let gasPrice = GWEI * 10n // 10 gwei default
  try {
    gasPrice = await publicClient.getGasPrice()
  } catch (err) {
    globalLog.warn('gas', 'Failed to fetch gasPrice, using default 10 gwei', { error: err.message })
  }

  const multiplier = STRATEGY_GAS_PRICE_MULTIPLIER[normalised]
  const scaledGasPrice = applyEscalation(
    BigInt(Math.ceil(Number(gasPrice) * multiplier)),
    retryAttempt,
  )

  globalLog.debug('gas', 'Legacy gas estimate', {
    strategy: normalised,
    retry_attempt: retryAttempt,
    gas_price_gwei: bigIntToGwei(scaledGasPrice).toFixed(4),
  })

  return {
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
    gasPrice: scaledGasPrice,
    isEip1559: false,
    strategy: normalised,
    baseFeeGwei: null,
  }
}

/**
 * Escalate gas params for a replacement transaction.
 * Applies ESCALATION_MULTIPLIER once per additional retry.
 *
 * @param {{ maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint, gasPrice?: bigint, isEip1559: boolean }} prevGasParams
 * @param {number} retryAttempt  — current attempt index (1-based)
 * @returns {typeof prevGasParams}
 */
export function escalateGas(prevGasParams, retryAttempt) {
  if (prevGasParams.isEip1559) {
    return {
      ...prevGasParams,
      maxFeePerGas: applyEscalation(prevGasParams.maxFeePerGas, 1),
      maxPriorityFeePerGas: applyEscalation(prevGasParams.maxPriorityFeePerGas, 1),
    }
  }
  return {
    ...prevGasParams,
    gasPrice: applyEscalation(prevGasParams.gasPrice, 1),
  }
}
