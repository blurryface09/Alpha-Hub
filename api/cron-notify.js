import { createClient } from '@supabase/supabase-js'
import { detectProjectChanges, detectStealthDelay, shouldCheckThisTick, buildDedupKey, buildAlertTitle, buildAlertMessage, ALERT_TYPES } from '../worker/lib/monitor.js'
import { createAlert } from '../worker/lib/alerter.js'
import { buildWalletProfile, detectLargeMint, detectRepeatMint, detectWalletEntry } from '../worker/lib/wallet-intelligence.js'

const MONITOR_TICK_MS   = 5 * 60 * 1000
const MONITOR_BATCH     = 40
const OVERLAP_WINDOW_MS = 4 * 60 * 1000   // skip if last run < 4 min ago

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

// ── Structured logger ─────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  console[level === 'error' ? 'error' : 'log'](
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })
  )
}

// ── Supabase ──────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return true  // no secret configured → open (dev/staging)

  // Header: Authorization: Bearer <secret>
  const authHeader = req.headers.authorization || ''
  if (authHeader === `Bearer ${secret}`) return true

  // Query: ?secret=<secret>  (for cron-job.org URL-based auth)
  const qSecret = req.query?.secret || new URL(req.url, 'http://x').searchParams.get('secret')
  if (qSecret === secret) return true

  return false
}

// ── Overlap lock (DB-backed, safe across serverless instances) ────────────────

async function acquireLock(supabase) {
  const windowStart = new Date(Date.now() - OVERLAP_WINDOW_MS).toISOString()

  const { data } = await supabase
    .from('monitor_state')
    .select('last_checked_at')
    .eq('entity_type', 'cron_lock')
    .eq('entity_id', 'cron-notify')
    .eq('user_id', '00000000-0000-0000-0000-000000000000')
    .maybeSingle()

  if (data?.last_checked_at && data.last_checked_at > windowStart) {
    return false  // another instance ran recently
  }

  const { error: lockError } = await supabase
    .from('monitor_state')
    .upsert({
      user_id:        '00000000-0000-0000-0000-000000000000',
      entity_type:    'cron_lock',
      entity_id:      'cron-notify',
      last_checked_at: new Date().toISOString(),
    }, { onConflict: 'user_id,entity_type,entity_id' })
  if (lockError) log('warn', 'lock upsert error', { err: lockError.message })

  return true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(utcStr) {
  const d = new Date(utcStr)
  const pad = (n) => String(n).padStart(2, '0')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC'
}

function cleanPriceText(value) {
  const clean = String(value || '').trim()
  if (!clean || /^0x[a-fA-F0-9]{40}$/.test(clean)) return 'Free'
  return clean
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(chatId, text, replyMarkup) {
  if (!BOT_TOKEN || !chatId) return false
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' }
    if (replyMarkup) body.reply_markup = replyMarkup
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok || result?.ok === false) {
      log('error', 'telegram send failed', { description: result?.description || response.statusText })
      return false
    }
    return true
  } catch (e) {
    log('error', 'telegram error', { err: e.message })
    return false
  }
}

// ── Notification helpers ──────────────────────────────────────────────────────

async function markNotification(supabase, { userId, type, title, message, projectId }) {
  const { error } = await supabase
    .from('notifications')
    .insert({ user_id: userId, type, title, message, data: { project_id: projectId } })
  if (error) log('error', 'notification marker error', { err: error.message })
}

async function getSentNotificationKeys(supabase, userIds, types, since) {
  if (!userIds.length) return new Set()
  const { data, error } = await supabase
    .from('notifications')
    .select('user_id, type, data')
    .in('user_id', userIds)
    .in('type', types)
    .gte('created_at', since)
  if (error) {
    log('error', 'notification lookup error', { err: error.message })
    return new Set()
  }
  return new Set(
    (data || []).map((n) => {
      const projectId = n.data?.project_id || n.data?.projectId
      return projectId ? `${n.type}:${n.user_id}:${projectId}` : null
    }).filter(Boolean)
  )
}

// ── Status updater ────────────────────────────────────────────────────────────

async function updateProjectStatuses(supabase, now) {
  const nowIso      = now.toISOString()
  const missedBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()

  const { error: liveError } = await supabase
    .from('wl_projects').update({ status: 'live' })
    .eq('status', 'upcoming').not('mint_date', 'is', null).lte('mint_date', nowIso)
  if (liveError) log('error', 'live status update error', { err: liveError.message })

  const { error: missedError } = await supabase
    .from('wl_projects').update({ status: 'missed' })
    .eq('status', 'live').not('mint_date', 'is', null).lt('mint_date', missedBefore)
  if (missedError) log('error', 'missed status update error', { err: missedError.message })
}

// ── Mint reminders ────────────────────────────────────────────────────────────

async function runReminders(supabase, now) {
  let notified = 0
  const from = new Date(now.getTime() + 29 * 60 * 1000).toISOString()
  const to   = new Date(now.getTime() + 35 * 60 * 1000).toISOString()

  const { data: upcoming } = await supabase
    .from('wl_projects')
    .select('id, name, mint_date, mint_price, chain, wl_type, user_id')
    .eq('status', 'upcoming').gte('mint_date', from).lte('mint_date', to)

  if (!upcoming?.length) return notified

  const userIds = [...new Set(upcoming.map(p => p.user_id))]
  const { data: profiles } = await supabase
    .from('profiles').select('id, telegram_chat_id').in('id', userIds)
  const sentKeys = await getSentNotificationKeys(supabase, userIds, ['mint_reminder_30m'],
    new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString())

  const chatMap = {}
  profiles?.forEach(p => { if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id })

  for (const p of upcoming) {
    const chatId = chatMap[p.user_id]
    if (!chatId) continue
    const reminderKey = `mint_reminder_30m:${p.user_id}:${p.id}`
    if (sentKeys.has(reminderKey)) continue

    const chain   = (p.chain || 'eth').toUpperCase()
    const price   = cleanPriceText(p.mint_price)
    const title   = `Mint in ~30 min: ${p.name}`
    const message = `${chain} · ${price} · ${p.wl_type} · ${fmtTime(p.mint_date)}`

    const sent = await sendTelegram(chatId,
      `⏰ <b>${title}</b>\n\n${chain} · ${price} · ${p.wl_type}\n🕐 ${fmtTime(p.mint_date)}`)
    if (sent) {
      await markNotification(supabase, { userId: p.user_id, type: 'mint_reminder_30m', title, message, projectId: p.id })
      notified++
    }
  }
  return notified
}

// ── Live alerts ───────────────────────────────────────────────────────────────

async function runLiveAlerts(supabase, now) {
  let notified = 0
  const liveFrom = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()

  const { data: live } = await supabase
    .from('wl_projects')
    .select('id, name, mint_date, mint_price, chain, wl_type, mint_mode, contract_address, user_id')
    .eq('status', 'live').gte('mint_date', liveFrom)

  if (!live?.length) return notified

  const userIds = [...new Set(live.map(p => p.user_id))]
  const { data: profiles } = await supabase
    .from('profiles').select('id, telegram_chat_id').in('id', userIds)
  const sentKeys = await getSentNotificationKeys(supabase, userIds, ['mint_live'],
    new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString())

  const chatMap = {}
  profiles?.forEach(p => { if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id })

  for (const p of live) {
    const chatId = chatMap[p.user_id]
    if (!chatId) continue
    const liveKey = `mint_live:${p.user_id}:${p.id}`
    if (sentKeys.has(liveKey)) continue

    const chain  = (p.chain || 'eth').toUpperCase()
    const price  = cleanPriceText(p.mint_price)
    const isAuto = p.mint_mode === 'auto'
    const title  = `LIVE: ${p.name}`
    const message = `${chain} · ${price} · ${p.wl_type}\n` +
      (isAuto ? '⚡ Strike Mode will fire shortly' : 'Tap below to confirm or skip')

    let keyboard = null
    if (!isAuto && p.contract_address) {
      keyboard = { inline_keyboard: [[
        { text: '✅ Confirm Mint', callback_data: 'confirm:' + p.id },
        { text: '❌ Skip',         callback_data: 'skip:'    + p.id },
      ]] }
    }

    const sent = await sendTelegram(chatId, `🚨 <b>${title}</b>\n${message}`, keyboard)
    if (sent) {
      await markNotification(supabase, { userId: p.user_id, type: 'mint_live', title, message, projectId: p.id })
      notified++
    }
  }
  return notified
}

// ── Monitor sweep ─────────────────────────────────────────────────────────────

async function runMonitorSweep(supabase) {
  let alerted = 0
  const nowMs = Date.now()

  const { data: watchers } = await supabase
    .from('calendar_project_watchers')
    .select(`id, user_id, project_id, calendar_projects!inner(id, name, status, mint_date, mint_price, contract_address, chain, supply)`)
    .limit(MONITOR_BATCH)

  for (const watcher of watchers ?? []) {
    const project = watcher.calendar_projects
    if (!project) continue
    try {
      const { data: stateRow } = await supabase
        .from('monitor_state')
        .select('*')
        .eq('user_id', watcher.user_id)
        .eq('entity_type', 'project')
        .eq('entity_id', watcher.project_id)
        .maybeSingle()

      if (stateRow && !shouldCheckThisTick(project, stateRow.last_checked_at, MONITOR_TICK_MS, nowMs)) continue

      const changes = detectProjectChanges(stateRow, project)
      if (detectStealthDelay(project, nowMs)) {
        changes.push({ type: ALERT_TYPES.STEALTH_DELAY, severity: 'warning', field: 'status', from: project.status, to: 'delayed' })
      }

      for (const change of changes) {
        const dedupKey = buildDedupKey(change.type, watcher.project_id)
        const id = await createAlert(supabase, {
          userId:   watcher.user_id,
          type:     change.type,
          title:    buildAlertTitle(change.type, project.name),
          message:  buildAlertMessage(change.type, change, project),
          severity: change.severity,
          dedupKey,
          data: { project_id: watcher.project_id, project_name: project.name, chain: project.chain, change_from: change.from, change_to: change.to },
        })
        if (id) alerted++
      }

      await supabase.from('monitor_state').upsert({
        user_id: watcher.user_id, entity_type: 'project', entity_id: watcher.project_id,
        last_status: project.status, last_mint_date: project.mint_date ?? null,
        last_price: project.mint_price ?? null, last_supply: project.supply ?? null,
        last_contract: project.contract_address ?? null, last_checked_at: new Date().toISOString(),
      }, { onConflict: 'user_id,entity_type,entity_id' })
    } catch (e) {
      log('error', 'monitor sweep row error', { project_id: watcher.project_id, err: e.message })
    }
  }
  return alerted
}

// ── Wallet Intel sweep ────────────────────────────────────────────────────────

async function runWalletIntelSweep(supabase, now) {
  let alerted = 0
  const since = new Date(now.getTime() - MONITOR_TICK_MS * 2).toISOString()

  // Recent whale mints only
  const { data: recent } = await supabase
    .from('whale_activity')
    .select('id, user_id, wallet_address, contract_address, value_eth, chain, is_mint, method_name, tx_hash, timestamp')
    .eq('is_mint', true)
    .gte('timestamp', since)
    .limit(200)

  if (!recent?.length) return alerted

  // ── Update wallet_profiles (conviction cache) ──────────────────────────────
  const byWalletChain = {}
  for (const a of recent) {
    const key = `${a.wallet_address?.toLowerCase()}:${a.chain || 'eth'}`
    if (!byWalletChain[key]) byWalletChain[key] = []
    byWalletChain[key].push(a)
  }

  for (const [key, acts] of Object.entries(byWalletChain)) {
    const [address, chain] = key.split(':')
    // Pull full history for accurate scoring
    const { data: history } = await supabase
      .from('whale_activity')
      .select('is_mint, contract_address, value_eth, timestamp')
      .eq('wallet_address', address)
      .eq('chain', chain)
      .limit(500)

    const profile = buildWalletProfile(history || acts)
    await supabase.from('wallet_profiles').upsert({
      address, chain, ...profile, updated_at: new Date().toISOString(),
    }, { onConflict: 'address,chain' })
  }

  // ── Wallet-entry alerts (whale minted a project you track) ─────────────────
  const contracts = [...new Set(recent.map(a => a.contract_address).filter(Boolean))]
  const userIds   = [...new Set(recent.map(a => a.user_id).filter(Boolean))]

  if (contracts.length && userIds.length) {
    const { data: matchProjects } = await supabase
      .from('wl_projects')
      .select('id, name, user_id, contract_address')
      .in('contract_address', contracts)
      .in('user_id', userIds)

    for (const proj of matchProjects || []) {
      const trigger = recent.find(
        a => a.contract_address === proj.contract_address && a.user_id === proj.user_id
      )
      if (!trigger) continue
      const alert = detectWalletEntry(trigger, proj.name)
      if (!alert) continue
      const id = await createAlert(supabase, { userId: proj.user_id, ...alert })
      if (id) alerted++
    }
  }

  // ── Per-activity alerts: large mint + repeat mint ──────────────────────────
  for (const act of recent) {
    if (!act.user_id) continue

    // Large mint
    const largeAlert = detectLargeMint(act)
    if (largeAlert) {
      const id = await createAlert(supabase, { userId: act.user_id, ...largeAlert })
      if (id) alerted++
    }

    // Repeat mint — check for prior mint to same contract
    if (act.contract_address) {
      const { data: prior } = await supabase
        .from('whale_activity')
        .select('id')
        .eq('user_id', act.user_id)
        .eq('wallet_address', act.wallet_address)
        .eq('contract_address', act.contract_address)
        .eq('is_mint', true)
        .lt('timestamp', act.timestamp)
        .limit(1)
        .maybeSingle()

      const repeatAlert = detectRepeatMint(act, !!prior)
      if (repeatAlert) {
        const id = await createAlert(supabase, { userId: act.user_id, ...repeatAlert })
        if (id) alerted++
      }
    }
  }

  return alerted
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const startMs = Date.now()

  if (!isAuthorized(req)) {
    log('warn', 'cron-notify unauthorized', { ip: req.headers['x-forwarded-for'] })
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  const supabase = getSupabase()
  if (!supabase) {
    log('error', 'cron-notify missing env vars')
    return res.status(200).json({ ok: false, error: 'missing env vars' })
  }

  const locked = await acquireLock(supabase)
  if (!locked) {
    log('info', 'cron-notify skipped (overlap lock)')
    return res.status(200).json({ ok: true, skipped: true, reason: 'overlap' })
  }

  const now = new Date()
  log('info', 'cron-notify start', { ts: now.toISOString() })

  const stats = { reminders: 0, live_alerts: 0, monitor_alerted: 0, wallet_alerted: 0, errors: [] }

  try {
    await updateProjectStatuses(supabase, now)
  } catch (e) {
    stats.errors.push('status_update: ' + e.message)
    log('error', 'status update error', { err: e.message })
  }

  try {
    stats.reminders = await runReminders(supabase, now)
  } catch (e) {
    stats.errors.push('reminders: ' + e.message)
    log('error', 'reminders error', { err: e.message })
  }

  try {
    stats.live_alerts = await runLiveAlerts(supabase, now)
  } catch (e) {
    stats.errors.push('live_alerts: ' + e.message)
    log('error', 'live alerts error', { err: e.message })
  }

  try {
    stats.monitor_alerted = await runMonitorSweep(supabase)
  } catch (e) {
    stats.errors.push('monitor_sweep: ' + e.message)
    log('error', 'monitor sweep error', { err: e.message })
  }

  try {
    stats.wallet_alerted = await runWalletIntelSweep(supabase, now)
  } catch (e) {
    stats.errors.push('wallet_intel: ' + e.message)
    log('error', 'wallet intel sweep error', { err: e.message })
  }

  const duration_ms = Date.now() - startMs
  log('info', 'cron-notify complete', { ...stats, duration_ms })

  return res.status(200).json({
    ok: true,
    ts: now.toISOString(),
    duration_ms,
    reminders:       stats.reminders,
    live_alerts:     stats.live_alerts,
    monitor_alerted: stats.monitor_alerted,
    wallet_alerted:  stats.wallet_alerted,
    errors:          stats.errors.length ? stats.errors : undefined,
  })
}
