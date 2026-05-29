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

export async function getAuthToken() {
  // Prefer the live Supabase session (auto-refreshes expired tokens)
  try {
    const { data } = await supabase.auth.getSession()
    if (data?.session?.access_token) return data.session.access_token
  } catch {}
  // Fallback: read from localStorage directly (works on first paint before client hydrates)
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const parsed = JSON.parse(localStorage.getItem(key) || '{}')
        const token = parsed?.access_token
        if (token) return token
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

export async function directDelete(table, column, value, extraColumn, extraValue) {
  const token = await getAuthToken()
  if (!token) throw new Error('Not authenticated')
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  let endpoint = `${url}/rest/v1/${table}?${column}=eq.${value}`
  if (extraColumn && extraValue) endpoint += `&${extraColumn}=eq.${extraValue}`
  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + token,
    },
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(err.message || 'Delete failed')
  }
  return true
}

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
