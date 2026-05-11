import { createClient } from '@supabase/supabase-js'

const startedAt = Date.now()

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY

  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function getTreasuryAddress() {
  return (
    process.env.TREASURY_ADDRESS ||
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
    process.env.VITE_TREASURY_ADDRESS ||
    process.env.VITE_RECEIVER_WALLET ||
    ''
  )
}

function isWalletAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''))
}

async function checkSupabase() {
  const supabase = getSupabase()
  if (!supabase) {
    return {
      ok: false,
      latencyMs: null,
      error: 'Supabase env vars missing',
    }
  }

  const started = Date.now()
  const { error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .limit(1)

  return {
    ok: !error,
    latencyMs: Date.now() - started,
    error: error?.message || null,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const started = Date.now()
  const supabase = await checkSupabase()
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN)
  const cronProtected = Boolean(process.env.CRON_SECRET)
  const redisConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  )
  const rpcConfigured = Boolean(
    process.env.ALCHEMY_API_KEY ||
    process.env.VITE_ALCHEMY_API_KEY ||
    process.env.ETHERSCAN_API_KEY ||
    process.env.VITE_ETHERSCAN_API_KEY
  )
  const paymentConfigured = isWalletAddress(getTreasuryAddress())

  const checks = {
    api: { ok: true },
    supabase,
    telegram: { ok: telegramConfigured },
    cron: { ok: cronProtected },
    payment: {
      ok: paymentConfigured,
      status: paymentConfigured ? 'healthy' : 'down',
    },
    rpc: {
      ok: rpcConfigured,
      status: rpcConfigured ? 'healthy' : 'degraded',
    },
    redis: {
      ok: redisConfigured,
      optional: true,
      status: redisConfigured ? 'healthy' : 'optional',
    },
  }

  const degraded = Object.values(checks).some((check) => !check.ok && !check.optional)

  return res.status(200).json({
    ok: !degraded,
    status: degraded ? 'degraded' : 'operational',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    latencyMs: Date.now() - started,
    checks,
  })
}
