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

  // Skip if contract execution config already in cache — nothing to do
  const existing = getPrewarmStatus(contract, chain)
  if (existing.ready) {
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

    // Persist call_data + gas_limit so executor skips detection at T=0
    await supabase.from('mint_intents').update({
      call_data:  prepared.data,
      gas_limit:  prepared.gas,
      last_state: `Prewarmed: ${prepared.functionName} (${latencyMs}ms, ${prewarmStatus.confidence}% confidence)`,
      updated_at: new Date().toISOString(),
    }).eq('id', intent.id).catch(() => null)

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
    }).catch(() => null)

    return { ok: true, cacheHit: prepared.cacheHit, functionName: prepared.functionName, latencyMs, confidence: prewarmStatus.confidence }

  } catch (err) {
    const error = String(err?.shortMessage || err?.message || err).slice(0, 200)
    log.warn('prewarm', 'Prewarm failed (non-fatal — intent remains armed)', { intent_id: intent.id, error })
    return { ok: false, error }
  }
}
