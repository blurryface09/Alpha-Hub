#!/usr/bin/env node
/**
 * Strike Engine admin status CLI.
 * Run: node worker/cli/strike-status.js
 *
 * Shows: queue counts by status, executing/retrying intents, recent failures,
 *        RPC health snapshot, and recent execution events.
 *
 * Works without a live DB — prints a demo view if env is not configured.
 */

import { createClient } from '@supabase/supabase-js'
import { getRpcHealth, getRpcUrls } from '../lib/rpc.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const SHOW_DEMO = !SUPABASE_URL || !SUPABASE_KEY

const STATUS_COLORS = {
  armed: '\x1b[33m',      // yellow
  executing: '\x1b[36m',  // cyan
  retrying: '\x1b[35m',   // magenta
  success: '\x1b[32m',    // green
  failed: '\x1b[31m',     // red
  expired: '\x1b[90m',    // dark gray
  cancelled: '\x1b[90m',  // dark gray
  pending: '\x1b[37m',    // white
  queued: '\x1b[34m',     // blue
}
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

// ─── Formatting helpers ───────────────────────────────────────────────────────

function colorFor(status) {
  return STATUS_COLORS[String(status).toLowerCase()] || '\x1b[37m'
}

function bar(count, max, width = 20) {
  if (!max) return ' '.repeat(width)
  const filled = Math.round((count / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function relTime(isoStr) {
  if (!isoStr) return '—'
  const diffMs = Date.now() - new Date(isoStr).getTime()
  if (diffMs < 0) return 'in the future'
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s ago`
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`
  return `${Math.round(diffMs / 3_600_000)}h ago`
}

function padEnd(str, n) {
  return String(str).padEnd(n)
}

function padStart(str, n) {
  return String(str).padStart(n)
}

function line(width = 56) {
  return '─'.repeat(width)
}

// ─── Demo data ────────────────────────────────────────────────────────────────

function demoData() {
  return {
    counts: { armed: 3, queued: 0, executing: 1, retrying: 0, success: 14, failed: 2, expired: 1, cancelled: 0, pending: 0 },
    executing: [
      { id: 'abc123', project_name: 'Demo NFT', chain: 'eth', updated_at: new Date(Date.now() - 12000).toISOString(), last_state: 'Gas estimated' },
    ],
    recentFailed: [
      { id: 'def456', project_name: 'Example Drop', chain: 'base', updated_at: new Date(Date.now() - 300000).toISOString(), last_state: 'Strike failed safely', simulation_error: 'execution reverted: MintNotActive()' },
    ],
    recentEvents: [
      { intent_id: 'abc123', state: 'gas', message: 'Gas estimated', created_at: new Date(Date.now() - 12000).toISOString() },
      { intent_id: 'abc123', state: 'wallet', message: 'Wallet resolved', created_at: new Date(Date.now() - 13000).toISOString() },
      { intent_id: 'def456', state: 'failed', message: 'Strike failed safely', created_at: new Date(Date.now() - 300000).toISOString() },
    ],
  }
}

// ─── Live data ────────────────────────────────────────────────────────────────

async function liveData(supabase) {
  const ACTIVE_STATUSES = ['armed', 'queued', 'executing', 'retrying', 'pending']
  const ALL_STATUSES = [...ACTIVE_STATUSES, 'success', 'failed', 'expired', 'cancelled']

  const [intentsRes, eventsRes] = await Promise.all([
    supabase
      .from('mint_intents')
      .select('id,project_name,chain,status,updated_at,last_state,simulation_error,strike_enabled')
      .eq('strike_enabled', true)
      .in('status', ALL_STATUSES)
      .order('updated_at', { ascending: false })
      .limit(100),
    supabase
      .from('mint_execution_events')
      .select('intent_id,state,message,created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const intents = intentsRes.data ?? []
  const events = eventsRes.data ?? []

  const counts = {}
  for (const s of ALL_STATUSES) counts[s] = 0
  for (const i of intents) counts[i.status] = (counts[i.status] || 0) + 1

  return {
    counts,
    executing: intents.filter(i => ['executing', 'retrying'].includes(i.status)),
    recentFailed: intents.filter(i => i.status === 'failed').slice(0, 5),
    recentEvents: events,
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderHeader(isDemo) {
  const tag = isDemo ? `  ${DIM}[DEMO MODE — no DB configured]${RESET}` : ''
  console.log(`\n${BOLD}  STRIKE ENGINE STATUS${RESET}${tag}`)
  console.log(`  ${DIM}${new Date().toISOString()}${RESET}`)
  console.log(`  ${line()}`)
}

function renderQueue(counts) {
  console.log(`\n${BOLD}  QUEUE${RESET}`)
  const max = Math.max(...Object.values(counts), 1)
  const rows = [
    ['armed', counts.armed ?? 0],
    ['executing', counts.executing ?? 0],
    ['retrying', counts.retrying ?? 0],
    ['queued', counts.queued ?? 0],
    ['success', counts.success ?? 0],
    ['failed', counts.failed ?? 0],
    ['expired', counts.expired ?? 0],
    ['cancelled', counts.cancelled ?? 0],
  ]
  for (const [status, count] of rows) {
    const c = colorFor(status)
    const b = bar(count, max, 18)
    console.log(`  ${c}${padEnd(status, 10)}${RESET}  ${padStart(count, 4)}  ${DIM}${b}${RESET}`)
  }
}

function renderExecuting(executing) {
  if (!executing.length) return
  console.log(`\n${BOLD}  EXECUTING NOW${RESET}`)
  for (const i of executing) {
    const c = colorFor(i.status)
    console.log(`  ${c}${i.status.padEnd(10)}${RESET}  ${DIM}${i.id?.slice(0, 8)}…${RESET}  ${i.project_name ?? '(no name)'}`)
    if (i.last_state) console.log(`              ${DIM}↳ ${i.last_state}  ${relTime(i.updated_at)}${RESET}`)
  }
}

function renderFailed(failed) {
  if (!failed.length) return
  console.log(`\n${BOLD}  RECENT FAILURES${RESET}`)
  for (const i of failed) {
    console.log(`  ${colorFor('failed')}✗${RESET}  ${DIM}${i.id?.slice(0, 8)}…${RESET}  ${i.project_name ?? '(no name)'}  ${DIM}${relTime(i.updated_at)}${RESET}`)
    if (i.simulation_error) {
      const msg = String(i.simulation_error).slice(0, 72)
      console.log(`        ${DIM}↳ ${msg}${RESET}`)
    }
  }
}

function renderEvents(events) {
  if (!events.length) return
  console.log(`\n${BOLD}  RECENT EVENTS${RESET}`)
  for (const e of events.slice(0, 8)) {
    const ts = relTime(e.created_at)
    const id = e.intent_id?.slice(0, 8) ?? '?'
    const state = padEnd(e.state, 12)
    console.log(`  ${DIM}${id}…  ${state}${RESET}  ${e.message?.slice(0, 50)}  ${DIM}${ts}${RESET}`)
  }
}

function renderRpcHealth() {
  // Warm up health map with one chain lookup
  getRpcUrls('eth')
  getRpcUrls('base')
  const health = getRpcHealth()
  if (!health.length) return

  console.log(`\n${BOLD}  RPC HEALTH${RESET}`)
  for (const h of health.slice(0, 6)) {
    const dot = h.degraded ? `${colorFor('failed')}●${RESET}` : `${colorFor('success')}●${RESET}`
    const host = new URL(h.url).hostname.slice(0, 30)
    const latency = `${h.latency_ema_ms}ms`.padStart(7)
    const fails = h.fail_count > 0 ? `  ${colorFor('failed')}${h.fail_count} fail${RESET}` : ''
    console.log(`  ${dot}  ${padEnd(host, 30)}  ${DIM}${latency}${RESET}${fails}`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let data

  if (SHOW_DEMO) {
    data = demoData()
    renderHeader(true)
  } else {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    try {
      data = await liveData(supabase)
    } catch (err) {
      console.error(`  Failed to fetch live data: ${err.message}`)
      data = demoData()
    }
    renderHeader(false)
  }

  renderQueue(data.counts)
  renderExecuting(data.executing)
  renderFailed(data.recentFailed)
  renderEvents(data.recentEvents)
  renderRpcHealth()

  console.log(`\n  ${line()}\n`)
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
