const PROFILE_TABLE = 'execution_optimization_profiles'

function normalizeAddress(value) {
  const raw = String(value || '').trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(raw) ? raw : null
}

function normalizeChainKey(value) {
  const raw = String(value || 'eth').toLowerCase()
  if (raw.includes('base')) return 'base'
  if (raw.includes('ape')) return 'apechain'
  if (raw.includes('bnb') || raw.includes('bsc')) return 'bnb'
  return 'eth'
}

function numeric(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function weightedAverage(currentAvg, currentCount, nextValue) {
  const value = numeric(nextValue)
  if (value === null) return currentAvg || null
  const count = Math.max(0, Number(currentCount || 0))
  const avg = numeric(currentAvg) || 0
  return Number(((avg * count + value) / (count + 1)).toFixed(2))
}

export function compactOptimizationPayload(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
}

export function isOptimizationSchemaError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  const code = String(error?.code || '')
  return (
    code === '42P01' ||
    message.includes(PROFILE_TABLE) ||
    message.includes('schema cache') ||
    message.includes('relation') ||
    message.includes('column') ||
    message.includes('does not exist')
  )
}

export function rpcTimeoutMs(profile, fallback = 9000) {
  const avg = numeric(profile?.avg_latency_ms)
  if (!avg) return fallback
  return Math.max(7000, Math.min(22000, Math.round(avg * 3 + 5000)))
}

export function confirmationTimeoutMs(profile) {
  const avg = numeric(profile?.avg_confirmation_ms)
  if (!avg) return 90000
  return Math.max(45000, Math.min(240000, Math.round(avg * 2.5 + 20000)))
}

export function readinessBoostFromProfile(profile) {
  if (!profile) return 0
  const successCount = Number(profile.success_count || 0)
  const successRate = Number(profile.success_rate || 0)
  if (successCount <= 0 || successRate <= 0) return 0
  return Math.min(18, Math.round((successRate * 12) + Math.min(successCount, 6)))
}

export function gasFromProfile(estimatedGas, profile) {
  const estimated = BigInt(estimatedGas || 0)
  const avgGas = numeric(profile?.avg_gas)
  if (!avgGas || avgGas <= 0) return estimated
  const tuned = BigInt(Math.ceil(avgGas * 1.12))
  return tuned > estimated ? tuned : estimated
}

export function rpcLabelForUrl(chain, url, env = process.env) {
  if (!url) return null
  const upper = normalizeChainKey(chain).toUpperCase()
  const candidates = [
    `${upper}_RPC_URL`,
    `${upper}_RPC_URL_FALLBACK_1`,
    `${upper}_RPC_URL_FALLBACK_2`,
  ]
  return candidates.find(key => env[key] && env[key] === url) || 'default_rpc'
}

export function orderRpcCandidates(chain, profile, candidates = []) {
  const usable = candidates.filter(item => item?.url)
  if (!profile?.best_rpc) return usable
  return [
    ...usable.filter(item => item.label === profile.best_rpc),
    ...usable.filter(item => item.label !== profile.best_rpc),
  ]
}

export async function loadExecutionProfile(supabase, { chain, contractAddress }) {
  const contractKey = normalizeAddress(contractAddress)
  if (!supabase || !contractKey) return null
  try {
    const { data, error } = await supabase
      .from(PROFILE_TABLE)
      .select('*')
      .eq('chain', normalizeChainKey(chain))
      .eq('contract_key', contractKey)
      .maybeSingle()
    if (error) {
      if (isOptimizationSchemaError(error)) return null
      throw error
    }
    return data || null
  } catch (error) {
    if (!isOptimizationSchemaError(error)) {
      console.warn('[execution-optimize] profile load failed', String(error?.message || error))
    }
    return null
  }
}

export function optimizationTelemetry(profile, patch = {}) {
  return compactOptimizationPayload({
    contract: patch.contractAddress || profile?.contract_address || profile?.contract_key || null,
    chain: patch.chain || profile?.chain || null,
    avgLatency: patch.avgLatency ?? profile?.avg_latency_ms ?? null,
    successRate: patch.successRate ?? profile?.success_rate ?? null,
    bestRpc: patch.bestRpc ?? profile?.best_rpc ?? null,
    gasProfile: patch.gasProfile ?? {
      min: profile?.min_gas ?? null,
      avg: profile?.avg_gas ?? null,
      max: profile?.max_gas ?? null,
    },
  })
}

export async function recordOptimizationEvent(supabase, intent, metadata = {}) {
  if (!supabase || !intent?.id || !intent?.user_id) return
  try {
    await supabase.from('mint_execution_events').insert({
      intent_id: intent.id,
      user_id: intent.user_id,
      state: 'optimized',
      message: 'Execution profile updated.',
      metadata,
    })
  } catch (error) {
    if (!isOptimizationSchemaError(error)) {
      console.warn('[execution-optimize] event write failed', String(error?.message || error))
    }
  }
}

export async function recordExecutionOptimization(supabase, input = {}) {
  const contractKey = normalizeAddress(input.contractAddress)
  if (!supabase || !contractKey) return null
  const chain = normalizeChainKey(input.chain)
  const status = String(input.status || '').toLowerCase()
  const isSuccess = ['submitted', 'confirmed', 'success'].includes(status)
  const isFailure = ['failed', 'reverted', 'timeout'].includes(status)
  const now = new Date().toISOString()

  try {
    const existing = await loadExecutionProfile(supabase, { chain, contractAddress: contractKey })
    const previousSuccess = Number(existing?.success_count || 0)
    const previousFailure = Number(existing?.failure_count || 0)
    const nextSuccess = previousSuccess + (isSuccess ? 1 : 0)
    const nextFailure = previousFailure + (isFailure ? 1 : 0)
    const attempts = Math.max(1, nextSuccess + nextFailure)
    const gasValue = numeric(input.gasUsed)

    const row = compactOptimizationPayload({
      chain,
      contract_key: contractKey,
      contract_address: contractKey,
      contract_type: input.contractType || existing?.contract_type || null,
      best_rpc: isSuccess && input.rpcLabel ? input.rpcLabel : existing?.best_rpc || input.rpcLabel || null,
      best_function_path: isSuccess && input.functionName ? input.functionName : existing?.best_function_path || input.functionName || null,
      success_count: nextSuccess,
      failure_count: nextFailure,
      success_rate: Number((nextSuccess / attempts).toFixed(4)),
      avg_latency_ms: weightedAverage(existing?.avg_latency_ms, attempts - 1, input.latencyMs),
      avg_confirmation_ms: weightedAverage(existing?.avg_confirmation_ms, Math.max(previousSuccess, 0), input.confirmationMs),
      min_gas: gasValue === null ? existing?.min_gas ?? null : Math.min(Number(existing?.min_gas || gasValue), gasValue),
      max_gas: gasValue === null ? existing?.max_gas ?? null : Math.max(Number(existing?.max_gas || gasValue), gasValue),
      avg_gas: weightedAverage(existing?.avg_gas, attempts - 1, gasValue),
      retry_profile: {
        timeoutMs: rpcTimeoutMs(existing),
        lastStatus: status || null,
        lastError: input.errorMessage || null,
      },
      successful_pattern: isSuccess ? {
        functionName: input.functionName || null,
        functionSource: input.functionSource || null,
        gasUsed: gasValue,
        rpc: input.rpcLabel || null,
        updatedAt: now,
      } : existing?.successful_pattern || null,
      last_success_at: isSuccess ? now : existing?.last_success_at || null,
      last_failure_at: isFailure ? now : existing?.last_failure_at || null,
      updated_at: now,
    })

    let result
    if (existing?.id) {
      result = await supabase.from(PROFILE_TABLE).update(row).eq('id', existing.id).select().single()
    } else {
      result = await supabase.from(PROFILE_TABLE).insert({ ...row, created_at: now }).select().single()
    }
    if (result.error) {
      if (isOptimizationSchemaError(result.error)) return null
      throw result.error
    }
    const telemetry = optimizationTelemetry(result.data, {
      contractAddress: contractKey,
      chain,
      avgLatency: result.data?.avg_latency_ms,
      successRate: result.data?.success_rate,
      bestRpc: result.data?.best_rpc,
    })
    console.log('[execution-optimize]', telemetry)
    if (input.intent && isSuccess) await recordOptimizationEvent(supabase, input.intent, telemetry)
    return result.data
  } catch (error) {
    if (!isOptimizationSchemaError(error)) {
      console.warn('[execution-optimize] profile write failed', String(error?.message || error))
    }
    return null
  }
}
