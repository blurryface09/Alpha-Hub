/**
 * Execution security layer.
 * Validates transactions before broadcast, enforces spend caps, checks contract
 * allowlists, prevents duplicate submissions, and runs pre-broadcast simulations.
 * Every guard must fail loudly — silent pass-through is not acceptable here.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hardcoded mainnet chain IDs — never execute on these. */
const MAINNET_IDS = new Set([1, 8453, 56, 33139, 137, 42161, 10, 43114, 250])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ADDRESS_RE   = /^0x[0-9a-fA-F]{40}$/

// ─── Transaction validation ───────────────────────────────────────────────────

/**
 * Validate a transaction object before signing or broadcasting.
 * Throws with a descriptive message on the first validation failure.
 *
 * @param {object} tx  — { to, value, data, nonce?, chainId? }
 * @param {{ allowedChainId?: number }} [opts]
 */
export function validateTransaction(tx, opts = {}) {
  const errors = []

  // to address
  if (!tx.to) {
    errors.push('missing to address')
  } else if (!ADDRESS_RE.test(tx.to)) {
    errors.push(`to address format invalid: ${tx.to}`)
  } else if (tx.to.toLowerCase() === ZERO_ADDRESS) {
    errors.push('to address is the zero address — rejecting')
  }

  // value
  if (tx.value !== undefined) {
    if (typeof tx.value !== 'bigint') {
      errors.push(`value must be BigInt, got ${typeof tx.value}`)
    } else if (tx.value < 0n) {
      errors.push('value is negative')
    }
  }

  // data
  if (tx.data != null && (typeof tx.data !== 'string' || !tx.data.startsWith('0x'))) {
    errors.push('data must be a 0x-prefixed hex string')
  }

  // nonce
  if (tx.nonce !== undefined && (!Number.isInteger(tx.nonce) || tx.nonce < 0)) {
    errors.push(`nonce is invalid: ${tx.nonce}`)
  }

  // chain safety
  if (opts.allowedChainId !== undefined) {
    if (MAINNET_IDS.has(Number(opts.allowedChainId))) {
      errors.push(`chain ID ${opts.allowedChainId} is a mainnet — live execution is disabled`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`Transaction validation failed: ${errors.join('; ')}`)
  }
}

// ─── Spend cap enforcement ────────────────────────────────────────────────────

/**
 * Enforce the intent's max_total_spend against the transaction value.
 * Throws if valueWei exceeds the cap. No-ops if no cap is configured.
 *
 * @param {object} intent
 * @param {bigint} valueWei  — ETH value being sent in the transaction (in wei)
 */
export function enforceSpendCap(intent, valueWei) {
  const maxEth = parseFloat(intent.max_total_spend ?? intent.max_mint_price ?? 0)
  if (!maxEth || maxEth <= 0) return // no cap configured

  const maxWei = BigInt(Math.round(maxEth * 1e18))
  if (valueWei > maxWei) {
    throw new Error(
      `Spend cap exceeded: transaction value ${Number(valueWei) / 1e18} ETH > max_total_spend ${maxEth} ETH`,
    )
  }
}

// ─── Contract allowlist ───────────────────────────────────────────────────────

/**
 * Parse the CONTRACT_ALLOWLIST env var into a normalised set.
 * Empty string / unset = no allowlist (all contracts permitted).
 * @returns {Set<string>}
 */
export function getAllowlistedContracts() {
  const raw = process.env.CONTRACT_ALLOWLIST ?? ''
  const entries = raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length === 42 && s.startsWith('0x'))
  return new Set(entries)
}

/**
 * Throw if CONTRACT_ALLOWLIST is non-empty and the given address is not in it.
 * On testnet with an empty allowlist, all contracts are permitted.
 *
 * @param {string} contractAddress
 * @param {string} [chain]  — informational only
 */
export function validateContractAllowlist(contractAddress, chain = '') {
  const allowlist = getAllowlistedContracts()
  if (!allowlist.size) return // no allowlist configured — all contracts permitted

  const normalized = contractAddress.toLowerCase()
  if (!allowlist.has(normalized)) {
    throw new Error(
      `Contract allowlist rejection: ${contractAddress} (chain: ${chain}) is not in the execution allowlist`,
    )
  }
}

// ─── Duplicate tx prevention ──────────────────────────────────────────────────

/**
 * Prevent double-submission by checking whether the intent already has a
 * tx_hash set or has an existing submitted/confirmed mint_attempts row.
 * Throws if a duplicate is detected.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} intentId
 */
export async function preventDuplicateTx(supabase, intentId) {
  // Check intent row for existing tx_hash
  const { data: intent } = await supabase
    .from('mint_intents')
    .select('id, tx_hash, status')
    .eq('id', intentId)
    .maybeSingle()

  if (intent?.tx_hash) {
    throw new Error(
      `Duplicate tx prevention: intent ${intentId} already has tx_hash ${intent.tx_hash} — refusing to re-broadcast`,
    )
  }

  // Check mint_attempts for an existing submitted/confirmed attempt
  const { data: attempts } = await supabase
    .from('mint_attempts')
    .select('id, tx_hash, status')
    .eq('intent_id', intentId)
    .in('status', ['submitted', 'confirmed'])
    .limit(1)

  if (attempts?.length) {
    throw new Error(
      `Duplicate tx prevention: intent ${intentId} already has a ${attempts[0].status} attempt (${attempts[0].tx_hash ?? 'no hash'})`,
    )
  }
}

// ─── Pre-broadcast simulation ─────────────────────────────────────────────────

/**
 * Simulate the transaction via eth_call before broadcasting.
 * Returns a result object — does NOT throw on revert (caller decides how to handle).
 * Network errors return success=false with isRevert=false so callers can distinguish.
 *
 * @param {import('viem').PublicClient} publicClient
 * @param {object} tx  — { to, data, value, from, maxFeePerGas?, maxPriorityFeePerGas? }
 * @returns {Promise<{ success: boolean, revertReason: string|null, isRevert: boolean }>}
 */
export async function preBroadcastSimulate(publicClient, tx) {
  try {
    await publicClient.call({
      to:    tx.to,
      data:  tx.data,
      value: tx.value,
      from:  tx.from,
      ...(tx.maxFeePerGas         ? { maxFeePerGas:         tx.maxFeePerGas }         : {}),
      ...(tx.maxPriorityFeePerGas ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
      ...(tx.gas                  ? { gas:                  tx.gas }                  : {}),
    })
    return { success: true, revertReason: null, isRevert: false }
  } catch (err) {
    const msg      = String(err?.shortMessage || err?.message || err).slice(0, 400)
    const isRevert = /revert|execution reverted|invalid opcode/i.test(msg)
    return { success: false, revertReason: msg, isRevert }
  }
}
