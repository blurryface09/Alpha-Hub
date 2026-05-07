/**
 * Vercel Cron Job — runs every 5 minutes.
 * Sends 30-minute reminder notifications for upcoming mints.
 * Add to vercel.json: "crons": [{ "path": "/api/cron-notify", "schedule": "*/5 * * * *" }]
 *
 * Required env vars: TELEGRAM_BOT_TOKEN, SUPABASE_SERVICE_KEY, VITE_SUPABASE_URL, CRON_SECRET
 */

import { createClient } from '@supabase/supabase-js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    })
  } catch {}
}

export default async function handler(req, res) {
  // Vercel passes Authorization: Bearer <CRON_SECRET> for cron invocations
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${cronSecret}`) return res.status(401).end()
  }

  const now = new Date()
  // 30–35 min window — catches projects in next 5-minute cron slot
  const from = new Date(now.getTime() + 29 * 60 * 1000).toISOString()
  const to = new Date(now.getTime() + 35 * 60 * 1000).toISOString()

  let notified = 0

  // ---- 30-min reminders -------------------------------------------------
  const { data: upcoming } = await supabase
    .from('wl_projects')
    .select('id, name, mint_date, mint_price, chain, wl_type, user_id')
    .eq('status', 'upcoming')
    .gte('mint_date', from)
    .lte('mint_date', to)

  if (upcoming?.length) {
    // Fetch telegram_chat_ids for involved users
    const userIds = [...new Set(upcoming.map(p => p.user_id))]
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, telegram_chat_id')
      .in('id', userIds)

    const chatMap = {}
    profiles?.forEach(p => { if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id })

    for (const p of upcoming) {
      const chatId = chatMap[p.user_id]
      if (!chatId) continue
      const chain = (p.chain || 'eth').toUpperCase()
      const price = p.mint_price || 'Free'
      const time = new Date(p.mint_date).toLocaleString()
      await sendTelegram(chatId,
        `⏰ <b>Mint in ~30 min: ${p.name}</b>\n\n${chain} · ${price} · ${p.wl_type}\n🕐 ${time}`
      )
      notified++
    }
  }

  // ---- Live-mint pulse (re-notify every 5 min if still live) ------------
  // Only notify if the project went live in the last 5 min (avoid spam)
  const liveFrom = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const { data: live } = await supabase
    .from('wl_projects')
    .select('id, name, mint_date, mint_price, chain, wl_type, mint_mode, contract_address, user_id')
    .eq('status', 'live')
    .gte('mint_date', liveFrom)   // only newly-live projects

  if (live?.length) {
    const userIds = [...new Set(live.map(p => p.user_id))]
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, telegram_chat_id')
      .in('id', userIds)

    const chatMap = {}
    profiles?.forEach(p => { if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id })

    for (const p of live) {
      const chatId = chatMap[p.user_id]
      if (!chatId) continue
      const chain = (p.chain || 'eth').toUpperCase()
      const price = p.mint_price || 'Free'
      const isAuto = p.mint_mode === 'auto'
      const text =
        `🚨 <b>LIVE: ${p.name}</b>\n` +
        `${chain} · ${price} · ${p.wl_type}\n` +
        (isAuto ? `⚡ Auto-mint active — keep the app open!` : ``)

      const keyboard = (!isAuto && p.contract_address) ? {
        inline_keyboard: [[
          { text: '✅ Confirm Mint', callback_data: `confirm:${p.id}` },
          { text: '❌ Skip', callback_data: `skip:${p.id}` },
        ]],
      } : null

      await sendTelegram(chatId, text, keyboard ? { reply_markup: keyboard } : {})
      notified++
    }
  }

  res.status(200).json({ ok: true, notified })
}
