import { createClient } from '@supabase/supabase-js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) return null

  return createClient(url, key)
}

function fmtTime(utcStr) {
  const d = new Date(utcStr)

  const pad = (n) =>
    String(n).padStart(2, '0')

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]

  return (
    months[d.getUTCMonth()] +
    ' ' +
    d.getUTCDate() +
    ', ' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ' UTC'
  )
}

function cleanPriceText(value) {
  const clean = String(value || '').trim()
  if (!clean || /^0x[a-fA-F0-9]{40}$/.test(clean)) return 'Free'
  return clean
}

async function sendTelegram(
  chatId,
  text,
  replyMarkup
) {
  if (!BOT_TOKEN || !chatId) return false

  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }

    if (replyMarkup) {
      body.reply_markup = replyMarkup
    }

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )

    const result = await response.json().catch(() => null)

    if (!response.ok || result?.ok === false) {
      console.error(
        'telegram send failed:',
        result?.description || response.statusText
      )
      return false
    }

    return true
  } catch (e) {
    console.error('telegram error:', e.message)
    return false
  }
}

async function markNotification(
  supabase,
  { userId, type, title, message, projectId }
) {
  await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type,
      title,
      message,
      data: { project_id: projectId },
    })
    .then(() => {})
    .catch((e) => {
      console.error(
        'cron-notify notification marker error:',
        e.message
      )
    })
}

async function getSentNotificationKeys(
  supabase,
  userIds,
  types,
  since
) {
  if (!userIds.length) return new Set()

  const { data, error } = await supabase
    .from('notifications')
    .select('user_id, type, data')
    .in('user_id', userIds)
    .in('type', types)
    .gte('created_at', since)

  if (error) {
    console.error(
      'cron-notify notification lookup error:',
      error.message
    )
    return new Set()
  }

  return new Set(
    (data || [])
      .map((n) => {
        const projectId =
          n.data?.project_id ||
          n.data?.projectId
        return projectId
          ? `${n.type}:${n.user_id}:${projectId}`
          : null
      })
      .filter(Boolean)
  )
}

async function updateProjectStatuses(
  supabase,
  now
) {
  const nowIso = now.toISOString()
  const missedBefore = new Date(
    now.getTime() - 2 * 60 * 60 * 1000
  ).toISOString()

  const { error: liveError } = await supabase
    .from('wl_projects')
    .update({ status: 'live' })
    .eq('status', 'upcoming')
    .not('mint_date', 'is', null)
    .lte('mint_date', nowIso)

  if (liveError) {
    console.error(
      'cron-notify live status update error:',
      liveError.message
    )
  }

  const { error: missedError } = await supabase
    .from('wl_projects')
    .update({ status: 'missed' })
    .eq('status', 'live')
    .not('mint_date', 'is', null)
    .lt('mint_date', missedBefore)

  if (missedError) {
    console.error(
      'cron-notify missed status update error:',
      missedError.message
    )
  }
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret) {
      const auth =
        req.headers.authorization || ''

      if (auth !== `Bearer ${cronSecret}`) {
        return res.status(401).json({
          ok: false,
          error: 'unauthorized',
        })
      }
    }

    const supabase = getSupabase()

    if (!supabase) {
      console.error(
        'cron-notify: missing Supabase env vars'
      )

      return res.status(200).json({
        ok: false,
        error: 'missing env vars',
      })
    }

    const now = new Date()

    await updateProjectStatuses(
      supabase,
      now
    )

    const from = new Date(
      now.getTime() + 29 * 60 * 1000
    ).toISOString()

    const to = new Date(
      now.getTime() + 35 * 60 * 1000
    ).toISOString()

    let notified = 0

    try {
      const { data: upcoming } = await supabase
        .from('wl_projects')
        .select(
          'id, name, mint_date, mint_price, chain, wl_type, user_id'
        )
        .eq('status', 'upcoming')
        .gte('mint_date', from)
        .lte('mint_date', to)

      if (upcoming?.length) {
        const userIds = [
          ...new Set(
            upcoming.map((p) => p.user_id)
          ),
        ]

        const { data: profiles } =
          await supabase
            .from('profiles')
            .select(
              'id, telegram_chat_id'
            )
            .in('id', userIds)

        const sentKeys =
          await getSentNotificationKeys(
            supabase,
            userIds,
            ['mint_reminder_30m'],
            new Date(
              now.getTime() - 3 * 60 * 60 * 1000
            ).toISOString()
          )

        const chatMap = {}

        profiles?.forEach((p) => {
          if (p.telegram_chat_id) {
            chatMap[p.id] =
              p.telegram_chat_id
          }
        })

        for (const p of upcoming) {
          const chatId =
            chatMap[p.user_id]

          if (!chatId) continue

          const reminderKey =
            `mint_reminder_30m:${p.user_id}:${p.id}`

          if (sentKeys.has(reminderKey)) {
            continue
          }

          const chain = (
            p.chain || 'eth'
          ).toUpperCase()

          const price =
            cleanPriceText(p.mint_price)

          const title =
            `Mint in ~30 min: ${p.name}`

          const message =
            `${chain} · ${price} · ${p.wl_type} · ${fmtTime(
              p.mint_date
            )}`

          const sent = await sendTelegram(
            chatId,
            `⏰ <b>${title}</b>\n\n${chain} · ${price} · ${p.wl_type}\n🕐 ${fmtTime(
              p.mint_date
            )}`
          )

          if (sent) {
            await markNotification(
              supabase,
              {
                userId: p.user_id,
                type: 'mint_reminder_30m',
                title,
                message,
                projectId: p.id,
              }
            )
            notified++
          }
        }
      }
    } catch (e) {
      console.error(
        'cron-notify reminders error:',
        e.message
      )
    }

    try {
      const liveFrom = new Date(
        now.getTime() - 2 * 60 * 60 * 1000
      ).toISOString()

      const { data: live } =
        await supabase
          .from('wl_projects')
          .select(
            'id, name, mint_date, mint_price, chain, wl_type, mint_mode, contract_address, user_id'
          )
          .eq('status', 'live')
          .gte('mint_date', liveFrom)

      if (live?.length) {
        const userIds = [
          ...new Set(
            live.map((p) => p.user_id)
          ),
        ]

        const { data: profiles } =
          await supabase
            .from('profiles')
            .select(
              'id, telegram_chat_id'
            )
            .in('id', userIds)

        const sentKeys =
          await getSentNotificationKeys(
            supabase,
            userIds,
            ['mint_live'],
            new Date(
              now.getTime() - 3 * 60 * 60 * 1000
            ).toISOString()
          )

        const chatMap = {}

        profiles?.forEach((p) => {
          if (p.telegram_chat_id) {
            chatMap[p.id] =
              p.telegram_chat_id
          }
        })

        for (const p of live) {
          const chatId =
            chatMap[p.user_id]

          if (!chatId) continue

          const liveKey =
            `mint_live:${p.user_id}:${p.id}`

          if (sentKeys.has(liveKey)) {
            continue
          }

          const chain = (
            p.chain || 'eth'
          ).toUpperCase()

          const price =
            cleanPriceText(p.mint_price)

          const isAuto =
            p.mint_mode === 'auto'

          const title = `LIVE: ${p.name}`

          const message =
            `${chain} · ${price} · ${p.wl_type}\n` +
            (isAuto
              ? '⚡ Strike Mode will fire shortly'
              : 'Tap below to confirm or skip')

          const text =
            `🚨 <b>${title}</b>\n` +
            message

          let keyboard = null

          if (
            !isAuto &&
            p.contract_address
          ) {
            keyboard = {
              inline_keyboard: [
                [
                  {
                    text: '✅ Confirm Mint',
                    callback_data:
                      'confirm:' + p.id,
                  },
                  {
                    text: '❌ Skip',
                    callback_data:
                      'skip:' + p.id,
                  },
                ],
              ],
            }
          }

          const sent = await sendTelegram(
            chatId,
            text,
            keyboard
          )

          if (sent) {
            await markNotification(
              supabase,
              {
                userId: p.user_id,
                type: 'mint_live',
                title,
                message,
                projectId: p.id,
              }
            )
            notified++
          }
        }
      }
    } catch (e) {
      console.error(
        'cron-notify live error:',
        e.message
      )
    }

    return res.status(200).json({
      ok: true,
      notified,
      ts: now.toISOString(),
    })
  } catch (e) {
    console.error(
      'cron-notify fatal:',
      e.message
    )

    return res.status(200).json({
      ok: false,
      error: e.message,
    })
  }
}
