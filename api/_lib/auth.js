import { createClient } from '@supabase/supabase-js'

export function getSupabaseUrl() {
  return process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
}

export function getAnonKey() {
  return process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
}

export function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
}

export function createAnonClient() {
  return createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function createServiceClient() {
  return createClient(getSupabaseUrl(), getServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function getBearerToken(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
}

export async function requireUser(req, res) {
  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }

  const supabase = createAnonClient()
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired session' })
    return null
  }

  return user
}

function userWallets(user) {
  const candidates = [
    user?.user_metadata?.wallet_address,
    user?.user_metadata?.walletAddress,
    user?.user_metadata?.address,
    user?.user_metadata?.sub,
    user?.app_metadata?.wallet_address,
    user?.app_metadata?.walletAddress,
    user?.app_metadata?.address,
    user?.app_metadata?.sub,
    user?.identities?.flatMap(identity => [
      identity?.identity_data?.wallet_address,
      identity?.identity_data?.walletAddress,
      identity?.identity_data?.address,
      identity?.identity_data?.sub,
    ]),
  ].flat().filter(Boolean)

  return candidates
    .map(value => String(value).toLowerCase())
    .filter(value => /^0x[a-f0-9]{40}$/.test(value))
}

export function userOwnsWallet(user, walletAddress) {
  const wallet = String(walletAddress || '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return false
  const wallets = userWallets(user)
  return wallets.includes(wallet)
}

export function isAdminUser(user) {
  const adminUserId = process.env.ADMIN_USER_ID
  if (adminUserId && user?.id === adminUserId) return true

  const adminWallet = (process.env.ADMIN_WALLET || process.env.VITE_ADMIN_WALLET || '').toLowerCase()
  if (!adminWallet) return false
  return userWallets(user).includes(adminWallet)
}

export async function requireAdmin(req, res) {
  const user = await requireUser(req, res)
  if (!user) return null
  if (!isAdminUser(user)) {
    res.status(403).json({ error: 'Admin access required' })
    return null
  }
  return user
}

export function requireEnv(res, names) {
  const missing = names.filter(name => !process.env[name])
  if (missing.length) {
    res.status(500).json({ error: `Missing server env: ${missing.join(', ')}` })
    return false
  }
  return true
}
