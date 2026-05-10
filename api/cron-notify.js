const { createClient } = require('@supabase/supabase-js')

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function fmtTime(utcStr) {
  const d = new Date(utcStr)
  const pad = function(n) { return String(n).padStart(2, '0') }
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC'
}

async function sendTelegram(chatId, text, extra) {
  if (!BOT_TOKEN || !chatId) return
  try {
    await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ chat_id: chatId, text: text, parse_mode: 'HTML' }, extra || {})),
    })
  } catch(e) {}
}

module.exports = async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret) {
      const auth = req.headers.authorization || ''
      if (auth !== 'Bearer ' + cronSecret) {
        return res.status(200).json({ ok: false, error: 'unauthorized' })
      }
    }

    const supabase = getSupabase()
    if (!supabase) {
      console.error('cron-notify: missing Supabase env vars')
      return res.status(200).json({ ok: false, error: 'missing env vars' })
    }

    const now = new Date()
    const from = new Date(now.getTime() + 29 * 60 * 1000).toISOString()
    const to = new Date(now.getTime() + 35 * 60 * 1000).toISOString()
    let notified = 0

    try {
      const upcomingResult = await supabase
        .from('wl_projects')
        .select('id, name, mint_date, mint_price, chain, wl_type, user_id')
        .eq('status', 'upcoming')
        .gte('mint_date', from)
        .lte('mint_date', to)

      const upcoming = upcomingResult.data
      if (upcoming && upcoming.length) {
        const userIds = upcoming.map(function(p) { return p.user_id }).filter(function(v, i, a) { return a.indexOf(v) === i })
        const profilesResult = await supabase
          .from('profiles')
          .select('id, telegram_chat_id')
          .in('id', userIds)

        const chatMap = {}
        if (profilesResult.data) {
          profilesResult.data.forEach(function(p) {
            if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id
          })
        }

        for (let i = 0; i < upcoming.length; i++) {
          const p = upcoming[i]
          const chatId = chatMap[p.user_id]
          if (!chatId) continue
          const chain = (p.chain || 'eth').toUpperCase()
          const price = p.mint_price || 'Free'
          await sendTelegram(chatId, '⏰ <b>Mint in ~30 min: ' + p.name + '</b>\n\n' + chain + ' · ' + price + ' · ' + p.wl_type + '\n🕐 ' + fmtTime(p.mint_date))
          notified++
        }
      }
    } catch(e) {
      console.error('cron-notify reminders error:', e.message)
    }

    try {
      const liveFrom = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
      const liveResult = await supabase
        .from('wl_projects')
        .select('id, name, mint_date, mint_price, chain, wl_type, mint_mode, contract_address, user_id')
        .eq('status', 'live')
        .gte('mint_date', liveFrom)

      const live = liveResult.data
      if (live && live.length) {
        const userIds = live.map(function(p) { return p.user_id }).filter(function(v, i, a) { return a.indexOf(v) === i })
        const profilesResult = await supabase
          .from('profiles')
          .select('id, telegram_chat_id')
          .in('id', userIds)

        const chatMap = {}
        if (profilesResult.data) {
          profilesResult.data.forEach(function(p) {
            if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id
          })
        }

        for (let i = 0; i < live.length; i++) {
          const p = live[i]
          const chatId = chatMap[p.user_id]
          if (!chatId) continue
          const chain = (p.chain || 'eth').toUpperCase()
          const price = p.mint_price || 'Free'
          const isAuto = p.mint_mode === 'auto'
          const text = '🚨 <b>LIVE: ' + p.name + '</b>\n' + chain + ' · ' + price + ' · ' + p.wl_type + '\n' +
            (isAuto ? '⚡ Server auto-mint will fire shortly' : 'Tap below to confirm or skip')

          const keyboard = (!isAuto && p.contract_address) ? {
            inline_keyboard: [[
              { text: '✅ Confirm Mint', callback_data: 'confirm:' + p.id },
              { text: '❌ Skip', callback_data: 'skip:' + p.id },
            ]],
          } : null

          await sendTelegram(chatId, text, keyboard ? { reply_markup: keyboard } : {})
          notified++
        }
      }
    } catch(e) {
      console.error('cron-notify live error:', e.message)
    }

    return res.status(200).json({ ok: true, notified: notified, ts: now.toISOString() })

  } catch(e) {
    console.error('cron-notify fatal:', e.message)
    return res.status(200).json({ ok: false, error: e.message })
  }
}
