import { useState, useEffect, useCallback, useRef } from 'react'
import { getAuthToken } from '../lib/supabase'

const POLL_READY_MS   = 5 * 60 * 1000  // 5min once execution_ready + fresh cache
const POLL_WAITING_MS = 30 * 1000      // 30s while unready or stale

const DEFAULT = {
  ready:            false,
  score:            0,
  status:           'not_ready',
  checks:           {},
  blockers:         [],
  warnings:         [],
  staleCache:       false,
  functionName:     null,
  gasEstimate:      null,
  successCount:     0,
  lastLatencyMs:    null,
  avgLatencyMs:     null,
  rpcCount:         { total: 0, healthy: 0 },
  execution_status: 'not_probed',
  loading:          false,
}

/**
 * Polls /api/mint/readiness for a project's contract execution readiness.
 * Server auto-triggers background prewarm when stale or unready.
 *
 * Poll rate: 30s while waiting, 5min once execution_ready with fresh cache.
 *
 * Returns { ready, score, status, checks, blockers, warnings, staleCache,
 *           functionName, gasEstimate, rpcCount, loading, refresh }
 */
export function useReadiness(project) {
  const [state, setState]     = useState(DEFAULT)
  const stateRef              = useRef(DEFAULT)
  const cancelRef             = useRef(false)
  const timerRef              = useRef(null)

  const contract = project?.contract_address
  const chain    = project?.chain

  const updateState = useCallback((next) => {
    stateRef.current = next
    setState(next)
  }, [])

  const run = useCallback(async () => {
    if (!contract || !chain) return
    updateState({ ...stateRef.current, loading: true })
    try {
      const token = await getAuthToken()
      if (!token || cancelRef.current) return
      const resp = await window.fetch('/api/mint/readiness', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ contractAddress: contract, chain }),
        signal:  AbortSignal.timeout(15000),
      })
      if (cancelRef.current) return
      const data = await resp.json().catch(() => ({}))
      if (!cancelRef.current && data?.readiness) {
        updateState({ ...DEFAULT, ...data.readiness, loading: false })
      }
    } catch {
      // best-effort — never surfaces to UI
    } finally {
      if (!cancelRef.current) updateState({ ...stateRef.current, loading: false })
    }
  }, [contract, chain, updateState])

  const scheduleNext = useCallback(() => {
    clearTimeout(timerRef.current)
    const s    = stateRef.current
    const ms   = (s.ready && !s.staleCache) ? POLL_READY_MS : POLL_WAITING_MS
    timerRef.current = setTimeout(async () => {
      await run()
      if (!cancelRef.current) scheduleNext()
    }, ms)
  }, [run])

  useEffect(() => {
    cancelRef.current = false
    stateRef.current  = DEFAULT
    setState(DEFAULT)

    ;(async () => {
      await run()
      if (!cancelRef.current) scheduleNext()
    })()

    return () => {
      cancelRef.current = true
      clearTimeout(timerRef.current)
    }
  }, [contract, chain]) // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, refresh: run }
}
