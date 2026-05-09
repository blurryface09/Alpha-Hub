// api/verify-payment.js
// Vercel serverless function — verifies ETH tx on Etherscan and activates subscription in Supabase

import { createClient } from '@supabase/supabase-js';

const PLAN_CONFIG = {
  weekly:    { days: 7,  ethMin: 0.003 },
  monthly:   { days: 30, ethMin: 0.009 },
  quarterly: { days: 90, ethMin: 0.024 },
};

// Your wallet address that receives payments — set in Vercel env vars
const RECEIVER_ADDRESS = process.env.VITE_RECEIVER_WALLET?.toLowerCase();

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role key — NOT the anon key
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { txHash, walletAddress, plan } = req.body;

  if (!txHash || !walletAddress || !plan) {
    return res.status(400).json({ error: 'Missing txHash, walletAddress, or plan' });
  }

  if (!PLAN_CONFIG[plan]) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    // 1. Check if tx already used
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('tx_hash', txHash)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Transaction already used' });
    }

    // 2. Fetch tx from Etherscan
    const etherscanUrl = `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${process.env.VITE_ETHERSCAN_API_KEY}`;
    const ethRes = await fetch(etherscanUrl);
    const ethData = await ethRes.json();
    const tx = ethData.result;

    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // 3. Validate receiver
    if (tx.to?.toLowerCase() !== RECEIVER_ADDRESS) {
      return res.status(400).json({ error: 'Transaction sent to wrong address' });
    }

    // 4. Validate sender matches wallet
    if (tx.from?.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Transaction sender does not match wallet' });
    }

    // 5. Validate amount (value is in wei hex)
    const valueEth = parseInt(tx.value, 16) / 1e18;
    const planConfig = PLAN_CONFIG[plan];

    if (valueEth < planConfig.ethMin) {
      return res.status(400).json({
        error: `Insufficient payment. Expected at least ${planConfig.ethMin} ETH, got ${valueEth.toFixed(6)} ETH`,
      });
    }

    // 6. Check tx is confirmed (block number exists)
    if (!tx.blockNumber) {
      return res.status(400).json({ error: 'Transaction not yet confirmed. Please wait and try again.' });
    }

    // 7. Write subscription to Supabase
    const now = new Date();
    const expiresAt = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000);

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
      }, {
        onConflict: 'wallet_address', // update if wallet already exists
      });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Failed to activate subscription' });
    }

    return res.status(200).json({
      success: true,
      plan,
      expiresAt: expiresAt.toISOString(),
      daysGranted: planConfig.days,
    });

  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
