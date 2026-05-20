/**
 * Transaction resilience helpers for Strike execution.
 *
 * This layer records real tx lifecycle state only. It never invents a
 * replacement hash or confirmation; when the chain cannot prove an outcome, the
 * state remains pending/recovering for the next worker pass or manual review.
 */

const DEFAULT_CONFIRMATION_TIMEOUT_MS = Number(process.env.TX_CONFIRMATION_TIMEOUT_MS || 90_000)

function now() {
  return new Date().toISOString()
}

function safeText(value, fallback = null) {
  const raw = value === undefined || value === null ? '' : String(value)
  return raw.trim() || fallback
}

function txTelemetry(fields = {}) {
  const payload = {
    intent: fields.intentId || null,
    tx: fields.txHash || null,
    chain: fields.chain || null,
    state: fields.state || null,
    nonce: fields.nonce ?? null,
    replacement: fields.replacementHash || null,
    latencyMs: fields.latencyMs ?? null,
    reason: fields.reason || null,
  }
  console.log('[tx-resilience]', payload)
  return payload
}

async function writeEvent(supabase, intent, state, message, metadata = {}) {
  if (!supabase || !intent?.id || !intent?.user_id) return null
  const row = {
    intent_id: intent.id,
    user_id: intent.user_id,
    state,
    message,
    metadata,
  }
  try {
    await supabase.from('mint_execution_events').insert(row)
  } catch {}
  return row
}

async function writeAttempt(supabase, intent, status, patch = {}) {
  if (!supabase || !intent?.id || !intent?.user_id) return null
  const row = {
    intent_id: intent.id,
    mint_intent_id: intent.id,
    user_id: intent.user_id,
    status,
    ...patch,
  }
  try {
    await supabase.from('mint_attempts').insert(row)
  } catch {}
  return row
}

async function updateIntent(supabase, intent, patch = {}) {
  if (!supabase || !intent?.id) return null
  try {
    const { error } = await supabase
      .from('mint_intents')
      .update({ ...patch, updated_at: now() })
      .eq('id', intent.id)
    if (!error) return null
    const msg = String(error.message || '').toLowerCase()
    if (msg.includes('schema cache') || msg.includes('column')) {
      const { tx_resilience_state, replacement_tx_hash, last_nonce, ...safePatch } = patch
      await supabase
        .from('mint_intents')
        .update({ ...safePatch, updated_at: now() })
        .eq('id', intent.id)
    }
  } catch {}
  return null
}

export async function recordTxState(supabase, intent, state, options = {}) {
  const txHash = options.txHash || options.hash || intent?.tx_hash || null
  const metadata = {
    tx_hash: txHash,
    chain: options.chain || intent?.chain || null,
    nonce: options.nonce ?? null,
    previous_tx_hash: options.previousTxHash || null,
    replacement_tx_hash: options.replacementHash || null,
    gas_strategy: options.gasStrategy || null,
    gas: options.gas || null,
    reason: options.reason || null,
    error: options.error || null,
    latency_ms: options.latencyMs ?? null,
  }
  const message = options.message || txStateMessage(state)
  txTelemetry({
    intentId: intent?.id,
    txHash,
    chain: metadata.chain,
    state,
    nonce: metadata.nonce,
    replacementHash: metadata.replacement_tx_hash,
    latencyMs: metadata.latency_ms,
    reason: metadata.reason || metadata.error,
  })
  await writeEvent(supabase, intent, state, message, metadata)

  if (['pending', 'replaced', 'accelerated', 'confirmed', 'reverted', 'dropped', 'recovering'].includes(state)) {
    await writeAttempt(supabase, intent, state, {
      tx_hash: txHash,
      error_message: metadata.error || metadata.reason || null,
      metadata,
    })
  }

  const lastState = message
  const intentPatch = {
    tx_resilience_state: state,
    last_state: lastState,
  }
  if (metadata.nonce !== null && metadata.nonce !== undefined) intentPatch.last_nonce = Number(metadata.nonce)
  if (metadata.replacement_tx_hash) intentPatch.replacement_tx_hash = metadata.replacement_tx_hash
  if (txHash && ['pending', 'confirmed', 'reverted', 'dropped'].includes(state)) intentPatch.tx_hash = txHash
  if (state === 'pending') {
    intentPatch.status = 'pending'
    intentPatch.strike_enabled = false
  }
  if (state === 'confirmed') {
    intentPatch.status = 'success'
    intentPatch.strike_enabled = false
  }
  if (state === 'reverted' || state === 'dropped') {
    intentPatch.status = state
    intentPatch.strike_enabled = false
  }
  await updateIntent(supabase, intent, intentPatch)
}

function txStateMessage(state) {
  switch (state) {
    case 'pending': return 'Transaction pending on-chain.'
    case 'accelerating': return 'Gas is being bumped for a faster retry.'
    case 'accelerated': return 'Replacement transaction submitted with higher gas.'
    case 'replaced': return 'Original transaction was replaced.'
    case 'recovering': return 'Checking transaction status after timeout.'
    case 'confirmed': return 'Transaction confirmed on-chain.'
    case 'reverted': return 'Transaction reverted on-chain.'
    case 'dropped': return 'Transaction appears dropped from the mempool.'
    default: return 'Transaction state updated.'
  }
}

export function classifyTxError(error) {
  const msg = String(error?.shortMessage || error?.message || error || '').toLowerCase()
  if (msg.includes('replacement') || msg.includes('repriced')) return 'replaced'
  if (msg.includes('underpriced') || msg.includes('fee too low') || msg.includes('gas')) return 'gas_bump_needed'
  if (msg.includes('nonce too low') || msg.includes('already known') || msg.includes('nonce')) return 'nonce_sync'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'confirmation_timeout'
  if (msg.includes('dropped') || msg.includes('mempool')) return 'dropped'
  if (msg.includes('revert') || msg.includes('failed')) return 'reverted'
  return 'unknown'
}

export async function syncNonceAfterFailure(publicClient, address, nonceTracker, intent, supabase) {
  if (!publicClient || !address || !nonceTracker) return null
  try {
    const nonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' })
    nonceTracker.set(address, nonce)
    await recordTxState(supabase, intent, 'recovering', {
      nonce,
      reason: 'nonce_sync_recovery',
      message: 'Nonce refreshed from chain.',
    })
    return nonce
  } catch (error) {
    await recordTxState(supabase, intent, 'recovering', {
      reason: 'nonce_sync_failed',
      error: safeText(error?.message || error),
      message: 'Nonce recovery could not complete.',
    })
    return null
  }
}

export async function waitForReceiptWithRecovery({
  supabase,
  intent,
  publicClient,
  txHash,
  chain,
  nonce,
  walletAddress,
  nonceTracker,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
}) {
  const startedAt = Date.now()
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: timeoutMs,
    })
    const latencyMs = Date.now() - startedAt
    if (receipt?.status === 'success') {
      await recordTxState(supabase, intent, 'confirmed', {
        txHash,
        chain,
        nonce,
        latencyMs,
        gas: receipt?.gasUsed?.toString?.(),
      })
    } else {
      await recordTxState(supabase, intent, 'reverted', {
        txHash,
        chain,
        nonce,
        latencyMs,
        reason: 'receipt_status_reverted',
      })
    }
    return { status: receipt?.status === 'success' ? 'confirmed' : 'reverted', receipt, latencyMs }
  } catch (error) {
    const reason = classifyTxError(error)
    await recordTxState(supabase, intent, 'recovering', {
      txHash,
      chain,
      nonce,
      reason,
      error: safeText(error?.message || error),
      message: 'Confirmation timed out. Checking transaction recovery state.',
    })

    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
      if (receipt?.status === 'success') {
        await recordTxState(supabase, intent, 'confirmed', {
          txHash,
          chain,
          nonce,
          latencyMs: Date.now() - startedAt,
          gas: receipt?.gasUsed?.toString?.(),
          reason: 'receipt_found_after_timeout',
        })
        return { status: 'confirmed', receipt, latencyMs: Date.now() - startedAt }
      }
      if (receipt) {
        await recordTxState(supabase, intent, 'reverted', {
          txHash,
          chain,
          nonce,
          latencyMs: Date.now() - startedAt,
          reason: 'receipt_found_after_timeout',
        })
        return { status: 'reverted', receipt, latencyMs: Date.now() - startedAt }
      }
    } catch {}

    if (publicClient && walletAddress && nonce !== undefined && nonce !== null) {
      try {
        const chainNonce = await publicClient.getTransactionCount({ address: walletAddress, blockTag: 'pending' })
        if (nonceTracker) nonceTracker.set(walletAddress, chainNonce)
        if (chainNonce > Number(nonce)) {
          await recordTxState(supabase, intent, 'dropped', {
            txHash,
            chain,
            nonce,
            reason: 'nonce_advanced_without_receipt',
            message: 'Transaction was not found after nonce advanced.',
          })
          return { status: 'dropped', receipt: null, latencyMs: Date.now() - startedAt }
        }
      } catch {}
    }

    await recordTxState(supabase, intent, 'pending', {
      txHash,
      chain,
      nonce,
      reason: 'confirmation_pending_after_timeout',
      message: 'Transaction is still pending after confirmation timeout.',
    })
    return { status: 'pending', receipt: null, latencyMs: Date.now() - startedAt }
  }
}
