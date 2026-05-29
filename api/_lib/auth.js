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
    user?.user_metadata?.custom_claims?.address,
    user?.user_metadata?.sub,
    user?.app_metadata?.wallet_address,
    user?.app_metadata?.walletAddress,
    user?.app_metadata?.address,
    user?.app_metadata?.custom_claims?.address,
    user?.app_metadata?.sub,
    user?.identities?.flatMap(identity => [
      identity?.identity_data?.wallet_address,
      identity?.identity_data?.walletAddress,
      identity?.identity_data?.address,
      identity?.identity_data?.custom_claims?.address,
      identity?.identity_data?.sub,
    ]),
  ].flat().filter(Boolean)

  return candidates
    .map(value => String(value).toLowerCase())
    .map(value => value.startsWith('web3:ethereum:') ? value.replace('web3:ethereum:', '') : value)
    .filter(value => /^0x[a-f0-9]{40}$/.test(value))
}

export function userOwnsWallet(user, walletAddress) {
  const wallet = String(walletAddress || '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return false
  const wallets = userWallets(user)
  return wallets.includes(wallet)
}

export function isAdminUser(user) {
  // SEC-1 / SEC-2: Admin check MUST be keyed on ADMIN_USER_ID (Supabase user UUID) only.
  //
  // The old wallet-match path read from user_metadata, which any authenticated user can
  // write via supabase.auth.updateUser(). An attacker who knows the admin wallet address
  // (previously leaked via VITE_ADMIN_WALLET in the client bundle) could set their own
  // user_metadata.wallet_address to that value and gain admin access.
  //
  // VITE_ADMIN_WALLET is intentionally NOT consulted here. Set ADMIN_USER_ID in your
  // server-only env (Vercel / Railway) to the Supabase UUID of the admin account.
  const adminUserId = process.env.ADMIN_USER_ID
  if (!adminUserId) return false // no admin configured → no admin access
  return user?.id === adminUserId
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
