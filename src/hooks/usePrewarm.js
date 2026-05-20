import { useState, useEffect } from 'react'
import { getAuthToken } from '../lib/supabase'

/**
 * Fires a background prewarm request for a project's contract.
 * On subsequent mints the server will hit the in-memory cache and skip
 * ABI detection + function iteration — saving 1-10s of preparation time.
 *
 * Returns { ready, confidence, functionName, loading }
 * Never throws — prewarm is always best-effort.
 */
export function usePrewarm(project) {
  const [status, setStatus] = useState({ ready: false, confidence: 0, functionName: null, successCount: 0 })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const contract = project?.contract_address
    const chain = project?.chain
    if (!contract || !chain) return

    let cancelled = false

    async function run() {
      setLoading(true)
      try {
        const token = await getAuthToken()
        if (!token || cancelled) return
        const resp = await fetch('/api/mint/prewarm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            contractAddress: contract,
            chain,
            mintPrice: project.mint_price || '0',
            quantity: project.max_mint || 1,
          }),
          signal: AbortSignal.timeout(25000),
        })
        if (cancelled) return
        const data = await resp.json().catch(() => ({}))
        if (data?.prewarm && !cancelled) setStatus(data.prewarm)
      } catch {
        // best-effort — never surface to UI
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => { cancelled = true }
  }, [project?.contract_address, project?.chain])

  return { ...status, loading }
}
