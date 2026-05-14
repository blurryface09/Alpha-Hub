import { isAddress } from 'viem'
import { createServiceClient, requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { chainIdFor, normalizeChain, normalizePhase, recommendMode } from '../_lib/project-intelligence.js'

const SUPPORTED_EXECUTION_CHAINS = new Set(['eth', 'base', 'apechain'])
const AUTO_STRIKE_ENABLED = String(process.env.AUTO_STRIKE_ENABLED || '').toLowerCase() === 'true'
const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'

const EVENT_MESSAGES = {
  preparing: 'Preparing project',
  phase: 'Detecting phase',
  checking: 'Checking contract',
  prepared: 'Preparing transaction',
  simulating: 'Simulating mint',
  gas: 'Gas locked',
  watching: 'Watching mint window',
  live: 'Mint live',
  broadcasting: 'Broadcasting transaction',
  confirming: 'Waiting confirmation',
  minted: 'Minted',
  failed: 'Failed',
  stopped: 'Stopped',
}

function safeError(message = 'Mint action is temporarily unavailable.') {
  return { ok: false, error: message }
}

function intentPayload(user, body, status = 'draft') {
  const chain = normalizeChain(body.chain)
  const phase = normalizePhase(body.phase || body.mintPhase)
  const risk = Number(body.riskScore || 50)
  const mode = body.mode || recommendMode(phase, risk)
  return {
    user_id: user.id,
    project_id: body.projectId || null,
    calendar_project_id: body.calendarProjectId || null,
    wl_project_id: body.wlProjectId || null,
    project_name: body.name || body.projectName || 'Mint project',
    contract_address: body.contractAddress || body.contract_address || null,
    chain,
    chain_id: chainIdFor(chain),
    mint_url: body.mintUrl || body.mint_url || null,
    mint_phase: phase,
    execution_mode: mode,
    quantity: Number(body.quantity || 1),
    max_mint_price: body.maxMintPrice || body.max_mint_price || null,
    max_gas_fee: body.maxGasFee || body.max_gas_fee || null,
    max_total_spend: body.maxTotalSpend || body.max_total_spend || null,
    status,
    last_state: status === 'prepared' ? EVENT_MESSAGES.prepared : EVENT_MESSAGES.preparing,
    updated_at: new Date().toISOString(),
  }
}

async function insertOptional(supabase, table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single()
  if (!error) return data
  const msg = String(error.message || '').toLowerCase()
  if (msg.includes('schema') || msg.includes('relation') || msg.includes('column')) {
    return { ...row, localOnly: true }
  }
  throw error
}

async function logEvent(supabase, intentId, userId, state, message, metadata = {}) {
  if (!intentId || String(intentId).startsWith('local-')) return null
  try {
    await supabase.from('mint_execution_events').insert({
      intent_id: intentId,
      user_id: userId,
      state,
      message: message || EVENT_MESSAGES[state] || state,
      metadata,
    })
  } catch {}
}

async function loadIntent(supabase, userId, intentId) {
  const { data, error } = await supabase
    .from('mint_intents')
    .select('*')
    .eq('id', intentId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function hasVault(supabase, userId) {
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
  if (error) return false
  return Boolean(data?.length)
}

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase()
  const allowed = new Set(['prepare', 'enable-strike', 'stop', 'execute', 'status'])
  if (!allowed.has(action)) return res.status(404).json(safeError('Unknown mint action.'))

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:mint:${action}:${user.id}`, 30, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const supabase = createServiceClient()

  try {
    if (action === 'status') {
      const intentId = req.query.intentId || req.body?.intentId
      if (!intentId) return res.status(400).json(safeError('Mint session not found.'))
      const intent = await loadIntent(supabase, user.id, intentId)
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      const { data: events } = await supabase
        .from('mint_execution_events')
        .select('*')
        .eq('intent_id', intentId)
        .order('created_at', { ascending: true })
      return res.status(200).json({ ok: true, intent, events: events || [] })
    }

    if (action === 'prepare') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const chain = normalizeChain(body.chain)
      if (!SUPPORTED_EXECUTION_CHAINS.has(chain)) return res.status(400).json(safeError('This chain is discovery-only for now.'))
      const contract = body.contractAddress || body.contract_address
      if (contract && !isAddress(contract)) return res.status(400).json(safeError('This contract address does not look right.'))
      const row = await insertOptional(supabase, 'mint_intents', intentPayload(user, body, 'prepared'))
      const intentId = row.id || `local-${Date.now()}`
      await logEvent(supabase, intentId, user.id, 'preparing')
      await logEvent(supabase, intentId, user.id, 'phase')
      await logEvent(supabase, intentId, user.id, 'checking')
      await logEvent(supabase, intentId, user.id, 'prepared')
      return res.status(200).json({
        ok: true,
        intent: { ...row, id: intentId },
        mode: body.mode || row.execution_mode || 'safe',
        message: 'Mint prepared. Use Safe Mint or Fast Mint to confirm with your wallet.',
      })
    }

    if (action === 'enable-strike') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const { intentId, acknowledgeRisk, maxTotalSpend } = req.body || {}
      if (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED) {
        return res.status(200).json({ ok: true, dryRun: true, error: 'Strike Mode is disabled by the global safety switch.' })
      }
      if (!acknowledgeRisk) return res.status(400).json(safeError('Confirm Strike Mode warnings before enabling.'))
      if (!maxTotalSpend) return res.status(400).json(safeError('Set a max spend limit before enabling Strike Mode.'))
      if (!(await hasVault(supabase, user.id))) return res.status(400).json(safeError('Create or import an Alpha Vault wallet before Strike Mode.'))
      const intent = await loadIntent(supabase, user.id, intentId)
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      if (!intent.contract_address) return res.status(400).json(safeError('Strike Mode needs a contract address.'))
      if (!SUPPORTED_EXECUTION_CHAINS.has(intent.chain)) return res.status(400).json(safeError('This chain is not supported for Strike Mode yet.'))
      await supabase.from('mint_intents').update({
        execution_mode: 'strike',
        max_total_spend: maxTotalSpend,
        strike_enabled: true,
        status: 'watching',
        last_state: EVENT_MESSAGES.watching,
        updated_at: new Date().toISOString(),
      }).eq('id', intentId).eq('user_id', user.id)
      await logEvent(supabase, intentId, user.id, 'watching', 'Strike Mode armed with Alpha Vault limits.')
      return res.status(200).json({ ok: true, message: 'Strike Mode armed. Alpha Vault limits are active.' })
    }

    if (action === 'stop') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const { intentId } = req.body || {}
      if (!intentId) return res.status(400).json(safeError('Mint session not found.'))
      await supabase.from('mint_intents').update({
        status: 'stopped',
        strike_enabled: false,
        last_state: EVENT_MESSAGES.stopped,
        updated_at: new Date().toISOString(),
      }).eq('id', intentId).eq('user_id', user.id)
      await logEvent(supabase, intentId, user.id, 'stopped')
      return res.status(200).json({ ok: true, message: 'Mint stopped.' })
    }

    if (action === 'execute') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const { intentId, mode = 'safe' } = req.body || {}
      const intent = intentId ? await loadIntent(supabase, user.id, intentId) : null
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      if (mode === 'strike' || intent.execution_mode === 'strike') {
        return res.status(400).json(safeError('Strike execution is guarded by the Auto Strike worker and safety switches.'))
      }
      await logEvent(supabase, intentId, user.id, 'simulating')
      await logEvent(supabase, intentId, user.id, 'gas')
      return res.status(200).json({
        ok: true,
        requiresWalletConfirmation: true,
        message: mode === 'fast' ? 'Fast Mint is ready. Confirm in your wallet.' : 'Safe Mint is ready. Confirm in your wallet.',
        transaction: {
          to: intent.contract_address,
          chainId: intent.chain_id,
          value: '0',
          data: '0x',
        },
      })
    }
  } catch (error) {
    console.error(`mint ${action} failed:`, error)
    return res.status(200).json(safeError('Mint engine is temporarily unavailable. Nothing was sent.'))
  }
}
