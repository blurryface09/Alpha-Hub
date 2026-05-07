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

// Get auth token from the supabase client (always fresh, auto-refreshed)
async function getAuthToken() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) return session.access_token
  // Session missing — try a refresh before giving up
  const { data: { session: refreshed } } = await supabase.auth.refreshSession()
  return refreshed?.access_token || null
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
