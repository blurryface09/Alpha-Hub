import { createClient } from '@supabase/supabase-js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY  // anon key is fine — we just validate the user's token
)

async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return { ok: false, error: 'Bot token not configured' }
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  })
  return r.json()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // Validate caller is an authenticated Alpha-Hub user
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' })

  const { chat_id, project, type } = req.body || {}
  if (!chat_id || !project) return res.status(400).json({ error: 'Missing chat_id or project' })

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
        (isAuto ? `⚡ Auto-mint will fire — keep the app open!` : `Tap below to confirm or skip.`)
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

  const result = await sendTelegram(chat_id, text, keyboard ? { reply_markup: keyboard } : {})
  res.status(200).json(result)
}
