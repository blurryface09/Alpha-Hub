import { createServiceClient, requireUser, userOwnsWallet } from './_lib/auth.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:subscription:${user.id}`, 30, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const walletAddress = String(req.query.walletAddress || '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid walletAddress is required' })
  }

  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('wallet_address', walletAddress)
    .eq('verified', true)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ subscription: data || null })
}
