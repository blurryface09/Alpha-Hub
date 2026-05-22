/**
 * Mint Capture Profile API
 *
 * Actions:
 *   save   — persist a captured transaction as an execution profile
 *   list   — fetch profiles for a contract/project
 *   delete — remove a profile by id
 *   stats  — community learning stats for a contract
 */

import { requireUser, createAnonClient } from '../_lib/auth.js'

const TABLE = 'mint_capture_profiles'

function isCaptureSchemaError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  const code = String(err?.code || '')
  return code === '42P01' || msg.includes(TABLE) || msg.includes('schema cache') || msg.includes('does not exist')
}

function normalizeAddress(v) {
  const s = String(v || '').trim().toLowerCase()
  return /^0x[a-f0-9]+$/.test(s) ? s : null
}

function normalizeChain(v) {
  const s = String(v || 'eth').toLowerCase()
  if (s.includes('base')) return 'base'
  if (s.includes('ape')) return 'apechain'
  if (s.includes('bnb') || s.includes('bsc')) return 'bnb'
  return 'eth'
}

export default async function handler(req, res) {
  const { action } = req.query
  const allowed = new Set(['save', 'list', 'delete', 'stats'])
  if (!allowed.has(action)) return res.status(404).json({ error: 'Unknown capture action' })

  const user = await requireUser(req, res)
  if (!user) return

  const supabase = createAnonClient()

  // ── save ──────────────────────────────────────────────────────────────────────
  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' })
    const body = req.body || {}

    const contractAddress = normalizeAddress(body.contractAddress || body.contract_address)
    const chain = normalizeChain(body.chain)
    if (!contractAddress) return res.status(400).json({ error: 'contractAddress required' })

    const toAddress = normalizeAddress(body.toAddress || body.to_address || body.tx?.to)
    const calldata = String(body.calldata || body.tx?.data || '').toLowerCase() || null
    const selector = calldata?.slice(0, 10) || null
    const valueWei = String(body.tx?.value || body.valueWei || '0')
    const gasLimit = body.tx?.gas ? Number(body.tx.gas) : null

    const profile = {
      user_id: user.id,
      project_id: body.projectId || body.project_id || null,
      contract_address: contractAddress,
      chain,
      to_address: toAddress,
      calldata,
      selector,
      value_wei: valueWei,
      gas_limit: gasLimit,
      mint_function: body.mintFunction || body.mint_function || null,
      protocol: body.protocol || 'custom',
      router_address: body.routerAddress || body.router_address || toAddress,
      proof_required: Boolean(body.proofRequired ?? body.proof_required ?? false),
      proof_shape: body.proofShape || body.proof_shape || 'none',
      multicall: Boolean(body.multicall ?? false),
      gas_min: gasLimit,
      gas_max: gasLimit,
      gas_avg: gasLimit,
      sample_count: 1,
      verified: false,
      shared: Boolean(body.shared ?? false),
      source: body.source || 'capture',
      captured_at: new Date().toISOString(),
    }

    try {
      // Upsert: if a profile exists for this contract+chain+selector by same user, merge
      const { data: existing } = await supabase
        .from(TABLE)
        .select('id, sample_count, gas_min, gas_max, gas_avg')
        .eq('contract_address', contractAddress)
        .eq('chain', chain)
        .eq('user_id', user.id)
        .eq('selector', selector)
        .maybeSingle()

      if (existing) {
        const n = (existing.sample_count || 0) + 1
        const gAvg = existing.gas_avg && gasLimit
          ? Math.round(((existing.gas_avg * (n - 1)) + gasLimit) / n)
          : gasLimit || existing.gas_avg
        const { data, error } = await supabase
          .from(TABLE)
          .update({
            ...profile,
            sample_count: n,
            gas_min: gasLimit && existing.gas_min ? Math.min(existing.gas_min, gasLimit) : existing.gas_min || gasLimit,
            gas_max: gasLimit && existing.gas_max ? Math.max(existing.gas_max, gasLimit) : existing.gas_max || gasLimit,
            gas_avg: gAvg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single()
        if (error) throw error
        return res.status(200).json({ ok: true, profile: data, merged: true })
      }

      const { data, error } = await supabase.from(TABLE).insert(profile).select().single()
      if (error) throw error
      return res.status(200).json({ ok: true, profile: data, merged: false })
    } catch (err) {
      if (isCaptureSchemaError(err)) {
        return res.status(200).json({ ok: true, profile: profile, merged: false, tableNotReady: true })
      }
      console.error('[capture/save] error', err.message)
      return res.status(500).json({ error: 'Failed to save profile' })
    }
  }

  // ── list ──────────────────────────────────────────────────────────────────────
  if (action === 'list') {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST required' })
    const q = req.method === 'GET' ? req.query : (req.body || {})
    const contractAddress = normalizeAddress(q.contractAddress || q.contract_address)
    const chain = q.chain ? normalizeChain(q.chain) : null
    const projectId = q.projectId || q.project_id || null

    try {
      let query = supabase
        .from(TABLE)
        .select('id, contract_address, chain, selector, mint_function, protocol, router_address, proof_required, proof_shape, gas_avg, gas_min, gas_max, sample_count, verified, source, captured_at')
        .eq('user_id', user.id)
        .order('sample_count', { ascending: false })
        .limit(20)

      if (contractAddress) query = query.eq('contract_address', contractAddress)
      if (chain) query = query.eq('chain', chain)
      if (projectId) query = query.eq('project_id', projectId)

      const { data, error } = await query
      if (error) throw error
      return res.status(200).json({ ok: true, profiles: data || [] })
    } catch (err) {
      if (isCaptureSchemaError(err)) return res.status(200).json({ ok: true, profiles: [] })
      console.error('[capture/list] error', err.message)
      return res.status(500).json({ error: 'Failed to list profiles' })
    }
  }

  // ── delete ────────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' })
    const { profileId } = req.body || {}
    if (!profileId) return res.status(400).json({ error: 'profileId required' })
    try {
      const { error } = await supabase.from(TABLE).delete().eq('id', profileId).eq('user_id', user.id)
      if (error) throw error
      return res.status(200).json({ ok: true })
    } catch (err) {
      if (isCaptureSchemaError(err)) return res.status(200).json({ ok: true })
      return res.status(500).json({ error: 'Failed to delete profile' })
    }
  }

  // ── stats ─────────────────────────────────────────────────────────────────────
  if (action === 'stats') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' })
    const contractAddress = normalizeAddress(req.query.contractAddress || req.query.contract_address)
    if (!contractAddress) return res.status(400).json({ error: 'contractAddress required' })
    try {
      const { data, error } = await supabase
        .from(TABLE)
        .select('id, protocol, mint_function, selector, gas_avg, sample_count, verified, proof_required, source')
        .eq('contract_address', contractAddress)
        .order('sample_count', { ascending: false })
        .limit(5)
      if (error) throw error
      const profiles = data || []
      const topProfile = profiles[0] || null
      return res.status(200).json({
        ok: true,
        hasProfile: profiles.length > 0,
        totalSamples: profiles.reduce((s, p) => s + (p.sample_count || 1), 0),
        protocol: topProfile?.protocol || null,
        mintFunction: topProfile?.mint_function || null,
        gasAvg: topProfile?.gas_avg || null,
        proofRequired: topProfile?.proof_required || false,
        verified: topProfile?.verified || false,
        profiles,
      })
    } catch (err) {
      if (isCaptureSchemaError(err)) return res.status(200).json({ ok: true, hasProfile: false, totalSamples: 0, profiles: [] })
      return res.status(500).json({ error: 'Failed to load stats' })
    }
  }
}
