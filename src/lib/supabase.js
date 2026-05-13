import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const noopLock = async (name, acquireTimeout, fn) => fn()

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    lock: noopLock,
  },
})

// Get auth token — always uses SDK first for SIWE wallet sessions
// localStorage scan is a fast-path fallback for email sessions only
export async function getAuthToken() {
  // Primary: always try SDK first — works for both email and wallet SIWE sessions
  try {
    const { data: { session }, error } = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ])
    if (session?.access_token) return session.access_token
  } catch {}

  // Fallback: scan localStorage for email-based sessions
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const parsed = JSON.parse(localStorage.getItem(key) || '{}')
        const token = parsed?.access_token
        const exp = parsed?.expires_at

        if (!token) continue

        if (exp && exp * 1000 > Date.now() + 60_000) {
          return token
        }

        if (exp && exp * 1000 > Date.now() - 5 * 60_000) {
          supabase.auth.refreshSession().catch(() => {})
          return token
        }
      }
    }
  } catch {}

  return null
}

// Direct fetch for inserts - bypasses supabase-js lock completely
export async function directInsert(table, data) {
  const token = await Promise.race([
    getAuthToken(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Auth timeout — please refresh')), 5000))
  ])
  if (!token) throw new Error('Not authenticated — please sign in again')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)

  let response
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + token,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    })
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new Error('Save timed out — check your connection and try again')
    throw e
  }
  clearTimeout(timer)

  const text = await response.text()
  let result
  try { result = JSON.parse(text) } catch { result = null }

  if (!response.ok) {
    const msg = result?.message || result?.error || result?.hint || `Save failed (${response.status})`
    throw new Error(msg)
  }

  const row = Array.isArray(result) ? result[0] : result
  if (row) return row

  let query = supabase
    .from(table)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)

  if (data?.user_id) query = query.eq('user_id', data.user_id)
  if (data?.wallet_address) query = query.eq('wallet_address', data.wallet_address)
  if (data?.tx_hash) query = query.eq('tx_hash', data.tx_hash)

  const { data: rows, error } = await query.maybeSingle()
  if (rows && !error) return rows

  return { ...data, id: crypto.randomUUID(), created_at: new Date().toISOString() }
}

// Direct fetch for updates
export async function directUpdate(table, data, column, value) {
  const token = await Promise.race([
    getAuthToken(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Auth timeout — please refresh')), 5000))
  ])
  if (!token) throw new Error('Not authenticated — please sign in again')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)

  let response
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/${table}?${column}=eq.${value}`, {
      method: 'PATCH',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + token,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    })
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new Error('Update timed out — check your connection and try again')
    throw e
  }
  clearTimeout(timer)

  const text = await response.text()
  let result
  try { result = JSON.parse(text) } catch { result = null }
  if (!response.ok) {
    throw new Error(result?.message || result?.error || 'Update failed: ' + response.status)
  }
  return Array.isArray(result) ? result[0] : result
}

// Timeout wrapper
export async function withTimeout(promise, ms = 8000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Request timed out')), ms)
  })
  try {
    const result = await Promise.race([promise, timeout])
    clearTimeout(timer)
    return result
  } catch(e) {
    clearTimeout(timer)
    throw e
  }
}
