/**
 * Strike prewarm pipeline.
 *
 * Runs prepareMintTransaction for an armed intent before its execute_at window.
 * On success: populates the in-memory contract cache AND persists call_data + gas_limit
 * to the intent row so the executor can skip function detection entirely at T=0.
 *
 * Always soft — never throws. Failures leave the intent armed for normal execution.
 */

import { prepareMintTransaction } from '../../api/_lib/mint-engine.js'
import { getPrewarmStatus } from '../../api/_lib/contract-cache.js'
import { createLogger } from './logger.js'

function normaliseChain(chain = 'eth') {
  const text = String(chain || '').toLowerCase()
  if (text.includes('base')) return 'base'
  if (text.includes('ape')) return 'apechain'
  if (text.includes('bnb') || text.includes('bsc')) return 'bnb'
  return 'eth'
}

/**
 * Resolve the vault wallet address for a given intent.
 * Returns null if unavailable — prewarm will fall back to a placeholder address.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} intent
 * @returns {Promise<string|null>}
 */
async function resolveVaultAddress(supabase, intent) {
  if (!supabase || !intent.user_id) return null
  try {
    let query = supabase
      .from('alpha_vault_wallets')
      .select('address, wallet_address')
      .eq('user_id', intent.user_id)
      .eq('status', 'active')
    if (intent.vault_wallet_id) query = query.eq('id', intent.vault_wallet_id)
    const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
    return data?.address || data?.wallet_address || null
  } catch {
    return null
  }
}

/**
 * Prewarm a single armed intent.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} intent — row from mint_intents
 * @param {object} [opts]
 * @param {string} [opts.walletAddress] — override vault lookup (for testing)
 * @param {Function} [opts._prepareFn] — override prepareMintTransaction (for testing)
 * @returns {Promise<{ ok: boolean, cacheHit?: boolean, functionName?: string, latencyMs?: number, confidence?: number, error?: string }>}
 */
export async function prewarmIntent(supabase, intent, opts = {}) {
  const log = createLogger(intent.id, intent.user_id)
  const t0 = Date.now()

  const chain    = normaliseChain(intent.chain)
  const contract = intent.contract_address || intent.mint_contract_address

  if (!contract) {
    log.warn('prewarm', 'Skipping prewarm: no contract address', { intent_id: intent.id })
    return { ok: false, error: 'no_contract' }
  }

  // If contract execution config is already in cache, take the fast path:
  // run prepareMintTransaction (which hits the in-memory cache in ~200ms, no ABI fetch)
  // so we can still write call_data to the intent row. Without this, the executor
  // would fall back to slower inline detection at T=0 even though the cache is warm.
  const existing = getPrewarmStatus(contract, chain)
  if (existing.ready && intent.call_data) {
    // call_data already written to this intent — nothing to do at all
    log.info('prewarm', 'Contract already cached — prewarm skipped', {
      intent_id: intent.id,
      fn: existing.functionName,
      confidence: existing.confidence,
    })
    return { ok: true, cacheHit: true, functionName: existing.functionName, confidence: existing.confidence }
  }

  // Resolve wallet address: explicit override → vault lookup → placeholder
  const walletAddress =
    opts.walletAddress
    || await resolveVaultAddress(supabase, intent)
    || '0x0000000000000000000000000000000000000001'

  const prepareFn = opts._prepareFn || prepareMintTransaction

  try {
    const prepared = await prepareFn({
      chain,
      contractAddress: contract,
      walletAddress,
      mintPrice: intent.max_mint_price || intent.mint_price || '0',
      quantity: intent.quantity || 1,
      maxTotalSpend: intent.max_total_spend,
    }, null, supabase)

    const latencyMs  = Date.now() - t0
    const prewarmStatus = getPrewarmStatus(contract, chain)

    log.info('prewarm', 'Prewarm complete', {
      intent_id:   intent.id,
      fn:          prepared.functionName,
      source:      prepared.source,
      cache_hit:   prepared.cacheHit,
      latency_ms:  latencyMs,
      confidence:  prewarmStatus.confidence,
    })

    // Persist call_data + gas_limit + to + value so executor has everything at T=0 without
    // re-running prepareMintTransaction. 'to' may differ from contract_address for SeaDrop
    // (router address). 'value' is the exact wei amount required (computed from getPublicDrop).
    // DATALOSS-3: Log write-back failures — a silent failure means the executor won't see
    // prewarmed call_data and will fall back to inline detection at T=0 (slower, not fatal).
    await supabase.from('mint_intents').update({
      call_data:     prepared.data,
      gas_limit:     prepared.gas,
      to:            prepared.to,
      value:         prepared.value,
      function_name: prepared.functionName,
      last_state:    `Prewarmed: ${prepared.functionName} (${latencyMs}ms, ${prewarmStatus.confidence}% confidence)`,
      updated_at:    new Date().toISOString(),
    }).eq('id', intent.id).then(r => r, e => log.warn('prewarm', 'Prewarm write-back failed — executor will use inline detection at T=0', { intent_id: intent.id, error: e?.message }))

    await supabase.from('mint_execution_events').insert({
      intent_id: intent.id,
      user_id:   intent.user_id,
      state:     'prewarm',
      message:   `Contract prewarmed: ${prepared.functionName}`,
      metadata:  {
        fn:          prepared.functionName,
        source:      prepared.source,
        gas:         prepared.gas,
        cache_hit:   prepared.cacheHit,
        latency_ms:  latencyMs,
        confidence:  prewarmStatus.confidence,
        wallet:      walletAddress.slice(0, 10),
      },
    }).then(r => r, e => log.warn('prewarm', 'Prewarm event insert failed', { intent_id: intent.id, error: e?.message }))

    return { ok: true, cacheHit: prepared.cacheHit, functionName: prepared.functionName, latencyMs, confidence: prewarmStatus.confidence }

  } catch (err) {
    const error = String(err?.shortMessage || err?.message || err).slice(0, 200)
    log.warn('prewarm', 'Prewarm failed (non-fatal — intent remains armed)', { intent_id: intent.id, error })

    // Log an informative DB event for known contract states so the user sees
    // meaningful feedback in the execution history panel instead of silence.
    const lower = error.toLowerCase()
    let prewarmMsg = null
    let prewarmState = null
    // Note: prepareMintTransaction converts raw revert reasons via safeMessage(), so we also
    // match the converted strings (e.g. "not open yet" from "Mint is not open yet or has ended").
    if (
      lower.includes('not started') || lower.includes('not open') ||
      lower.includes('not active')  || lower.includes('sale not active') ||
      lower.includes('mint not active') || lower.includes('not yet') ||
      lower.includes('has not started') || lower.includes('not currently active') ||
      lower.includes('may be closed') || lower.includes('mint simulation failed')
    ) {
      prewarmMsg  = '⏳ Mint not open yet — Strike is armed and will fire at the scheduled time.'
      prewarmState = 'not_started'
    } else if (
      lower.includes('wrong eth') || lower.includes('incorrect payment') ||
      lower.includes('wrong value') || lower.includes('incorrect value') ||
      lower.includes('msg.value') || lower.includes('wrong payment')
    ) {
      prewarmMsg  = '💰 Paid mint detected — Strike will read on-chain price and execute at scheduled time.'
      prewarmState = 'paid_mint'
    } else if (lower.includes('sold out') || lower.includes('supply exhausted') || lower.includes('max supply')) {
      prewarmMsg  = '⚠️ Mint appears sold out — Strike will attempt anyway at execute time.'
      prewarmState = 'sold_out'
    } else if (lower.includes('allowlist') || lower.includes('not eligible') || lower.includes('not whitelisted')) {
      prewarmMsg  = '⚠️ Allowlist phase detected — Strike will attempt at execute time.'
      prewarmState = 'allowlist'
    }
    if (prewarmMsg && supabase) {
      await supabase.from('mint_execution_events').insert({
        intent_id: intent.id,
        user_id:   intent.user_id,
        state:     'prewarm',
        message:   prewarmMsg,
        metadata:  { prewarm_state: prewarmState, raw_error: error.slice(0, 100) },
      }).then(r => r, () => null)
      // Also surface the status on the intent itself so the project card shows it
      // without requiring the user to expand the execution history panel.
      await supabase.from('mint_intents').update({
        last_state: prewarmMsg,
        updated_at: new Date().toISOString(),
      }).eq('id', intent.id).then(r => r, () => null)
    }

    return { ok: false, error }
  }
}
