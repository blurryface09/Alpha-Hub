import { createClient } from '@supabase/supabase-js'
import { createServiceClient, requireUser } from './_lib/auth.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET

// Use service key on the server so we can read/write any user's data.
// Create lazily so missing env vars return JSON instead of crashing the function at import time.
let supabase

function getSupabase() {
  if (supabase) return supabase

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) return null

  supabase = createClient(url, key)
  return supabase
}

async function sendMessage(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return false
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || result?.ok === false) {
    console.error('telegram sendMessage failed:', result?.description || response.statusText)
    return false
  }
  return true
}

async function handleAppNotification(req, res) {
  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:telegram-notify:${user.id}`, 30, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const { project, type } = req.body || {}
  if (!project) return res.status(400).json({ error: 'Missing project' })

  const appSupabase = createServiceClient()
  const { data: profile } = await appSupabase
    .from('profiles')
    .select('telegram_chat_id')
    .eq('id', user.id)
    .single()

  const chatId = profile?.telegram_chat_id
  if (!chatId) return res.status(400).json({ error: 'Telegram is not linked' })

  const chain = (project.chain || 'eth').toUpperCase()
  const price = project.mint_price || 'Free'
  let text = ''
  let keyboard = null

  switch (type) {
    case 'reminder':
      text =
        `⏰ <b>Mint in 30 min: ${project.name}</b>\n\n` +
        `${chain} · ${price} · ${project.wl_type}\n` +
        `🕐 ${new Date(project.mint_date).toLocaleString()}`
      break
    case 'live': {
      const isAuto = project.mint_mode === 'auto'
      text =
        `🚨 <b>LIVE NOW: ${project.name}</b>\n\n` +
        `${chain} · ${price} · ${project.wl_type}\n` +
        (isAuto ? `⚡ Auto-mint will fire shortly.` : `Tap below to confirm or skip.`)
      if (!isAuto && project.contract_address) {
        keyboard = {
          inline_keyboard: [[
            { text: '✅ Confirm Mint', callback_data: `confirm:${project.id}` },
            { text: '❌ Skip', callback_data: `skip:${project.id}` },
          ]],
        }
      }
      break
    }
    case 'auto':
      text =
        `⚡ <b>Auto-minting: ${project.name}</b>\n\n` +
        `${chain} · ${price}\nTransaction firing now...`
      break
    case 'success':
      text =
        `✅ <b>Mint Success: ${project.name}</b>\n\n` +
        `TX: <code>${(project.tx_hash || '').slice(0, 20)}...</code>`
      break
    case 'failed':
      text =
        `❌ <b>Mint Failed: ${project.name}</b>\n\n` +
        `${project.error || 'Transaction rejected'}`
      break
    default:
      return res.status(400).json({ error: 'Unknown notification type' })
  }

  await sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {})
  return res.status(200).json({ ok: true })
}

async function answerCallback(queryId, text = '') {
  if (!BOT_TOKEN) return
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId, text }),
  })
}

// ------------------------------------------------------------------ handlers

async function handleStart(chatId, linkCode) {
  if (!linkCode) {
    return sendMessage(chatId,
      `👋 <b>Alpha-Hub Bot</b>\n\nGet real-time mint alerts and confirm mints right here.\n\n` +
      `Go to <b>Settings → Telegram</b> in the app to connect your account.`
    )
  }

  const { data: token } = await supabase
    .from('telegram_link_tokens')
    .select('user_id, created_at')
    .eq('token', linkCode)
    .single()

  if (!token) {
    return sendMessage(chatId, '❌ Link code is invalid or expired. Generate a new one in Settings.')
  }

  // Enforce 15-minute TTL
  const ageMs = Date.now() - new Date(token.created_at).getTime()
  if (ageMs > 15 * 60 * 1000) {
    await supabase.from('telegram_link_tokens').delete().eq('token', linkCode)
    return sendMessage(chatId, '❌ Link code expired (15 min limit). Generate a new one in Settings.')
  }

  // Save chat ID to profile
  await supabase.from('profiles')
    .update({ telegram_chat_id: String(chatId) })
    .eq('id', token.user_id)

  // Delete the used token
  await supabase.from('telegram_link_tokens').delete().eq('token', linkCode)

  return sendMessage(chatId,
    `✅ <b>Alpha-Hub connected!</b>\n\n` +
    `You'll receive real-time notifications here.\n\n` +
    `Commands:\n` +
    `/dashboard — all projects\n` +
    `/live — live mints right now\n` +
    `/upcoming — next mints\n` +
    `/help — show this menu`
  )
}

function normalizeCommand(text) {
  const [rawCommand = '', ...args] = String(text || '').trim().split(/\s+/)
  const command = rawCommand.split('@')[0].toLowerCase()
  return { command, args }
}

async function resolveProfile(chatId) {
  const { data } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('telegram_chat_id', String(chatId))
    .single()
  return data
}

async function handleDashboard(chatId, userId) {
  const { data: projects } = await supabase
    .from('wl_projects')
    .select('name, status, mint_date, mint_price, wl_type, chain')
    .eq('user_id', userId)
    .order('mint_date', { ascending: true, nullsFirst: false })
    .limit(12)

  if (!projects?.length) {
    return sendMessage(chatId, '📋 No projects yet. Add them in MintGuard.')
  }

  const emoji = { live: '🟢', upcoming: '⏰', minted: '✅', missed: '❌', cancelled: '🚫' }
  const lines = projects.map(p => {
    const e = emoji[p.status] || '⏰'
    const date = p.mint_date ? new Date(p.mint_date).toLocaleString() : 'TBD'
    const price = p.mint_price ? ` · ${p.mint_price}` : ''
    return `${e} <b>${p.name}</b> [${(p.chain || 'ETH').toUpperCase()}]${price}\n   ${p.wl_type} · ${date}`
  }).join('\n\n')

  return sendMessage(chatId, `📊 <b>Your MintGuard</b>\n\n${lines}`)
}

async function handleLive(chatId, userId) {
  const { data: projects } = await supabase
    .from('wl_projects')
    .select('id, name, mint_price, chain, contract_address, mint_mode, wl_type')
    .eq('user_id', userId)
    .eq('status', 'live')

  if (!projects?.length) {
    return sendMessage(chatId, '🟢 No live mints right now. You\'ll get a notification when one goes live.')
  }

  for (const p of projects) {
    const price = p.mint_price || 'Free'
    const hasContract = !!p.contract_address
    const isAuto = p.mint_mode === 'auto'

    const text =
      `🚨 <b>LIVE: ${p.name}</b>\n` +
      `${(p.chain || 'ETH').toUpperCase()} · ${price} · ${p.wl_type}\n` +
      (isAuto ? `⚡ Auto-mint will fire when the app is open` : ``)

    const keyboard = (!isAuto && hasContract) ? {
      inline_keyboard: [[
        { text: '✅ Confirm Mint', callback_data: `confirm:${p.id}` },
        { text: '❌ Skip', callback_data: `skip:${p.id}` },
      ]],
    } : null

    await sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {})
  }
}

async function handleUpcoming(chatId, userId) {
  const { data: projects } = await supabase
    .from('wl_projects')
    .select('name, mint_date, mint_price, chain, wl_type')
    .eq('user_id', userId)
    .eq('status', 'upcoming')
    .order('mint_date', { ascending: true, nullsFirst: false })
    .limit(6)

  if (!projects?.length) {
    return sendMessage(chatId, '⏰ No upcoming mints scheduled.')
  }

  const lines = projects.map(p => {
    const date = p.mint_date ? new Date(p.mint_date).toLocaleString() : 'TBD'
    return `⏰ <b>${p.name}</b> [${(p.chain || 'ETH').toUpperCase()}]\n   ${p.mint_price || 'Free'} · ${p.wl_type}\n   🕐 ${date}`
  }).join('\n\n')

  return sendMessage(chatId, `📅 <b>Upcoming Mints</b>\n\n${lines}`)
}

async function handleCallback(queryId, data, chatId) {
  await answerCallback(queryId)

  // Look up the user who owns this chat — all project mutations are scoped to them
  const profile = await resolveProfile(chatId)
  if (!profile) {
    return sendMessage(chatId, '❌ Account not linked. Use /start <code> from Settings.')
  }

  if (data.startsWith('confirm:')) {
    const projectId = data.replace('confirm:', '')

    // Ownership check: only update if the project belongs to this chat's user
    const { error } = await supabase
      .from('wl_projects')
      .update({ telegram_mint_approved: true })
      .eq('id', projectId)
      .eq('user_id', profile.id)

    if (error) {
      return sendMessage(chatId, '❌ Could not confirm mint. Try again in the app.')
    }

    return sendMessage(chatId,
      `✅ <b>Mint confirmed!</b>\n\n` +
      `Open Alpha-Hub to complete the transaction with your wallet.\n` +
      `The app will auto-execute it as soon as you connect.`
    )
  }

  if (data.startsWith('skip:')) {
    const projectId = data.replace('skip:', '')
    // Ownership check on skip too
    await supabase.from('wl_projects')
      .update({ telegram_mint_approved: false })
      .eq('id', projectId)
      .eq('user_id', profile.id)
    return sendMessage(chatId, '⏭ Skipped.')
  }
}

// ------------------------------------------------------------------ main

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.body?.project && req.body?.type) {
    return handleAppNotification(req, res)
  }

  supabase = getSupabase()
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'Supabase env vars missing' })
  }

  // Validate Telegram webhook secret
  if (WEBHOOK_SECRET) {
    const incoming = req.headers['x-telegram-bot-api-secret-token']
    if (incoming && incoming !== WEBHOOK_SECRET) return res.status(401).end()
    if (!incoming) console.warn('telegram webhook secret header missing; accepted for launch compatibility')
  }

  const { message, callback_query } = req.body || {}

  try {
    if (callback_query) {
      const { id, data, message: cbMsg } = callback_query
      await handleCallback(id, data || '', cbMsg?.chat?.id)
      return res.status(200).json({ ok: true })
    }

    if (message) {
      const chatId = message.chat.id
      const { command: cmd, args } = normalizeCommand(message.text)

      if (cmd === '/start') {
        await handleStart(chatId, args[0])
        return res.status(200).json({ ok: true })
      }

      const profile = await resolveProfile(chatId)
      if (!profile) {
        await sendMessage(chatId, '❌ Account not linked. Use /start <code> from Alpha-Hub Settings.')
        return res.status(200).json({ ok: true })
      }

      if (cmd === '/dashboard' || cmd === '/status') await handleDashboard(chatId, profile.id)
      else if (cmd === '/live') await handleLive(chatId, profile.id)
      else if (cmd === '/upcoming') await handleUpcoming(chatId, profile.id)
      else if (cmd === '/help' || cmd === '/start') {
        await sendMessage(chatId, `Commands:\n/dashboard · /live · /upcoming · /help`)
      } else {
        await sendMessage(chatId, `Commands:\n/dashboard · /live · /upcoming · /help`)
      }
    }
  } catch (e) {
    console.error('telegram webhook error:', e)
  }

  res.status(200).json({ ok: true })
}
