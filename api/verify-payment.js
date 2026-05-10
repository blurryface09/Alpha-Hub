import { createServiceClient, requireUser, userOwnsWallet } from './_lib/auth.js'
import { rateLimit, sendRateLimit } from './_lib/redis.js'
import { writeAuditLog } from './_lib/audit.js'

const PLAN_CONFIG = {
  weekly:    { days: 7,  ethMin: 0.0015 },
  monthly:   { days: 30, ethMin: 0.005 },
  quarterly: { days: 90, ethMin: 0.012 },
}

const RECEIVER_ADDRESS = process.env.VITE_RECEIVER_WALLET?.toLowerCase()

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:verify-payment:${user.id}`, 10, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const { txHash, walletAddress, plan } = req.body

  if (!txHash || !walletAddress || !plan) {
    return res.status(400).json({ error: 'Missing txHash, walletAddress, or plan' })
  }

  if (!PLAN_CONFIG[plan]) {
    return res.status(400).json({ error: 'Invalid plan' })
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }

  if (!userOwnsWallet(user, walletAddress)) {
    return res.status(403).json({ error: 'Wallet does not match authenticated session' })
  }

  try {
    const supabase = createServiceClient()
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('tx_hash', txHash)
      .single()

    if (existing) {
      return res.status(409).json({ error: 'Transaction already used' })
    }

    const etherscanKey = process.env.ETHERSCAN_API_KEY || process.env.VITE_ETHERSCAN_API_KEY
    const etherscanUrl = `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${etherscanKey}`
    const ethRes = await fetch(etherscanUrl)
    const ethData = await ethRes.json()
    const tx = ethData.result

    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' })
    }

    if (tx.to?.toLowerCase() !== RECEIVER_ADDRESS) {
      return res.status(400).json({ error: 'Transaction sent to wrong address' })
    }

    if (tx.from?.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Transaction sender does not match wallet' })
    }

    const valueEth = parseInt(tx.value, 16) / 1e18
    const planConfig = PLAN_CONFIG[plan]

    if (valueEth < planConfig.ethMin) {
      return res.status(400).json({
        error: `Insufficient payment. Expected at least ${planConfig.ethMin} ETH, got ${valueEth.toFixed(6)} ETH`,
      })
    }

    if (!tx.blockNumber) {
      return res.status(400).json({ error: 'Transaction not yet confirmed. Please wait and try again.' })
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000)

    const { error: insertError } = await supabase
      .from('subscriptions')
      .upsert({
        wallet_address: walletAddress.toLowerCase(),
        plan,
        tx_hash: txHash,
        chain_id: parseInt(tx.chainId || '0x1', 16),
        amount_eth: valueEth,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        verified: true,
        user_id: user.id,
      }, {
        onConflict: 'wallet_address',
      })

    if (insertError) {
      console.error('Supabase insert error:', insertError)
      return res.status(500).json({ error: 'Failed to activate subscription' })
    }

    await writeAuditLog(supabase, {
      action: 'subscription.activated',
      userId: user.id,
      metadata: {
        walletAddress: walletAddress.toLowerCase(),
        plan,
        txHash,
        amountEth: valueEth,
        expiresAt: expiresAt.toISOString(),
      },
    })

    return res.status(200).json({
      success: true,
      plan,
      expiresAt: expiresAt.toISOString(),
      daysGranted: planConfig.days,
    })

  } catch (err) {
    console.error('verify-payment error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
