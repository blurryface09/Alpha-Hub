/**
 * Server-side WhaleRadar poller.
 * Runs from Vercel Cron or an external cron service and writes activity into
 * Supabase, letting the browser consume realtime updates instead of polling.
 */

import { createClient } from '@supabase/supabase-js'

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api'
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || process.env.VITE_ETHERSCAN_API_KEY

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHAINS = {
  eth: { id: '1', name: 'Ethereum', symbol: 'ETH' },
  base: { id: '8453', name: 'Base', symbol: 'ETH' },
  bnb: { id: '56', name: 'BNB Chain', symbol: 'BNB' },
}

const MINT_METHOD_IDS = new Set([
  '0x40993b26',
  '0x1249c58b',
  '0x6a627842',
  '0xa0712d68',
  '0x84bb1e42',
  '0xd85d3d27',
  '0x2db11544',
  '0xefef39a1',
  '0x570d8e1d',
  '0x8ecfffd8',
])

function decodeMethodName(methodId) {
  const methods = {
    '0xa9059cbb': 'Token Transfer',
    '0x23b872dd': 'Token Transfer From',
    '0x095ea7b3': 'Approve',
    '0x38ed1739': 'DEX Swap (Sell)',
    '0x7ff36ab5': 'DEX Buy',
    '0x18cbafe5': 'DEX Sell',
    '0xd0e30db0': 'Wrap ETH',
    '0x2e1a7d4d': 'Unwrap ETH',
    '0xa22cb465': 'NFT Approval',
    '0x42842e0e': 'NFT Transfer',
    '0x40993b26': 'MINT',
    '0x1249c58b': 'MINT',
    '0x6a627842': 'MINT',
    '0xa0712d68': 'MINT',
    '0x84bb1e42': 'MINT',
    '0xd85d3d27': 'PUBLIC MINT',
    '0x2db11544': 'PUBLIC MINT',
    '0xefef39a1': 'PURCHASE',
    '0x570d8e1d': 'PRESALE MINT',
    '0x8ecfffd8': 'ALLOWLIST MINT',
    '0x715018a6': 'Renounce Ownership',
    '0xf2fde38b': 'Transfer Ownership',
    '0x3ccfd60b': 'Owner Withdraw',
  }
  return methods[methodId] || `Method ${methodId}`
}

async function fetchLatestTransactions(wallet) {
  const chain = CHAINS[wallet.chain || 'eth'] || CHAINS.eth
  const url = new URL(ETHERSCAN_V2)
  url.searchParams.set('chainid', chain.id)
  url.searchParams.set('module', 'account')
  url.searchParams.set('action', 'txlist')
  url.searchParams.set('address', wallet.wallet_address)
  url.searchParams.set('startblock', '0')
  url.searchParams.set('endblock', '99999999')
  url.searchParams.set('page', '1')
  url.searchParams.set('offset', '5')
  url.searchParams.set('sort', 'desc')
  url.searchParams.set('apikey', ETHERSCAN_KEY)

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data || data.status !== '1' || !Array.isArray(data.result)) return []

  const cutoffIdx = wallet.last_tx_hash
    ? data.result.findIndex(tx => tx.hash === wallet.last_tx_hash)
    : -1

  if (cutoffIdx === 0) return []
  return cutoffIdx > 0 ? data.result.slice(0, cutoffIdx) : data.result.slice(0, 1)
}

function normalizeTx(tx, wallet) {
  const methodId = tx.input?.slice(0, 10) || '0x'
  const wei = BigInt(tx.value || '0')
  const value = Number(wei / 10n ** 14n) / 10000
  return {
    wallet_address: wallet.wallet_address,
    user_id: wallet.user_id,
    wallet_label: wallet.label,
    chain: wallet.chain || 'eth',
    tx_hash: tx.hash,
    action_type: decodeMethodName(methodId),
    contract_address: tx.to || null,
    value_eth: value,
    method_id: methodId,
    method_name: decodeMethodName(methodId),
    is_mint: MINT_METHOD_IDS.has(methodId),
    timestamp: new Date(Number.parseInt(tx.timeStamp, 10) * 1000).toISOString(),
    raw_data: {
      from: tx.from,
      to: tx.to,
      gas_used: tx.gasUsed,
      gas_price: tx.gasPrice,
      is_error: tx.isError === '1',
    },
  }
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).end()
    }

    if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !ETHERSCAN_KEY) {
      return res.status(200).json({ ok: false, error: 'missing env vars' })
    }

    const { data: wallets, error } = await supabase
      .from('whale_watchlist')
      .select('id, user_id, wallet_address, label, chain, last_tx_hash')
      .eq('is_active', true)
      .order('last_checked', { ascending: true, nullsFirst: true })
      .limit(100)

    if (error) return res.status(200).json({ ok: false, error: error.message })
    if (!wallets?.length) return res.status(200).json({ ok: true, checked: 0, inserted: 0 })

    let checked = 0
    let inserted = 0

    for (const wallet of wallets) {
      try {
        const txs = await fetchLatestTransactions(wallet)
        checked++

        for (const tx of txs) {
          const row = normalizeTx(tx, wallet)
          const { data: insertedRow, error: upsertError } = await supabase
            .from('whale_activity')
            .upsert(row, { onConflict: 'user_id,tx_hash', ignoreDuplicates: true })
            .select('id')
            .maybeSingle()

          if (!upsertError && insertedRow) {
            inserted++
            await supabase.from('notifications').insert({
              user_id: wallet.user_id,
              type: row.is_mint ? 'whale_mint' : 'whale_move',
              title: `${row.is_mint ? 'WHALE MINTING' : 'Whale Move'} - ${wallet.label || wallet.wallet_address.slice(0, 10)}...`,
              message: `${row.method_name} · ${row.value_eth} ${CHAINS[row.chain]?.symbol || 'ETH'} · ${CHAINS[row.chain]?.name || row.chain}`,
              data: { tx_hash: tx.hash, wallet: wallet.wallet_address, chain: row.chain },
            }).then(() => {}).catch(() => {})
          }
        }

        await supabase
          .from('whale_watchlist')
          .update({
            last_tx_hash: txs[0]?.hash || wallet.last_tx_hash,
            last_checked: new Date().toISOString(),
          })
          .eq('id', wallet.id)
      } catch (error) {
        console.error(`whale-poll failed for ${wallet.id}:`, error.message)
      }
    }

    return res.status(200).json({ ok: true, checked, inserted })
  } catch (error) {
    console.error('whale-poll fatal:', error.message)
    return res.status(200).json({ ok: false, error: error.message })
  }
}
