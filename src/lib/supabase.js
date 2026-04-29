import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Simple client - no custom auth config to avoid lock issues
export const supabase = createClient(supabaseUrl, supabaseKey)

// Helper: wrap any supabase call with timeout
export async function withTimeout(promise, ms = 8000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Request timed out - check connection')), ms)
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
