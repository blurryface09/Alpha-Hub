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

// Get auth token — reads localStorage directly, no async SDK lock.
// Falls back to SDK only if no token found at all.
export async function getAuthToken() {
  let expiredToken = null

  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const parsed = JSON.parse(localStorage.getItem(key) || '{}')
        const token = parsed?.access_token
        const exp = parsed?.expires_at   // epoch seconds

        if (!token) continue

        if (exp && exp * 1000 > Date.now() + 60_000) {
          // Token valid for at least another 60s — use it immediately
          return token
        }

        if (exp && exp * 1000 > Date.now() - 5 * 60_000) {
          // Token expired within last 5 min — keep as fallback, kick off background refresh
          expiredToken = token
          supabase.auth.refreshSession().catch(() => {})
        }
      }
    }
  } catch {}

  // Return slightly-expired token rather than hanging — server will 401 if truly dead
  if (expiredToken) return expiredToken

  // True last resort: SDK with hard timeout
  try {
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ])
    return result?.data?.session?.access_token || null
  } catch {
    return null
  }
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

  // Supabase returns an array with the inserted row; if RLS blocks SELECT it returns []
  const row = Array.isArray(result) ? result[0] : result
  if (row) return row

  // RLS blocked the read-back — fall back to supabase-js to get the new row
  const { data: rows, error } = await supabase
    .from(table)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (rows && !error) return rows

  // Last resort: return the data we tried to insert (minus server-generated fields)
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
