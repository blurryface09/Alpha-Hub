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

// Get auth token from localStorage directly - bypasses client lock
function getAuthToken() {
  try {
    const stored = localStorage.getItem('sb-tlhdprppgkaqfiwgambu-auth-token')
    if (stored) return JSON.parse(stored)?.access_token
  } catch {}
  return null
}

// Direct fetch for inserts - bypasses supabase-js lock completely
export async function directInsert(table, data) {
  const token = getAuthToken()
  if (!token) throw new Error('Not authenticated - please sign in again')

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + token,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.message || result.error || 'Insert failed: ' + response.status)
  }
  return Array.isArray(result) ? result[0] : result
}

// Direct fetch for updates
export async function directUpdate(table, data, column, value) {
  const token = getAuthToken()
  if (!token) throw new Error('Not authenticated - please sign in again')

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${column}=eq.${value}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + token,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.message || result.error || 'Update failed: ' + response.status)
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
