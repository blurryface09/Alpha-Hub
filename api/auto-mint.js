/**
 * Server-side auto-mint cron — runs every minute via Vercel cron.
 * Finds live projects with mint_mode='auto', fires transactions using
 * each user's stored minting wallet. No browser or user interaction required.
 *
 * vercel.json cron: { "path": "/api/auto-mint", "schedule": "* * * * *" }
 * Required env vars: WALLET_ENCRYPTION_KEY, SUPABASE_SERVICE_KEY,
 *                    VITE_SUPABASE_URL, VITE_ALCHEMY_API_KEY,
 *                    TELEGRAM_BOT_TOKEN (optional), CRON_SECRET (optional)
 */

import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { createWalletClient, createPublicClient, http, parseEther, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, base, bsc } from 'viem/chains'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const ALCHEMY_KEY = process.env.VITE_ALCHEMY_API_KEY
const ETHERSCAN_KEY = process.env.VITE_ETHERSCAN_API_KEY
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

const CHAIN_CONFIG = {
  eth:  { chain: mainnet, rpc: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,  id: 1    },
  base: { chain: base,    rpc: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, id: 8453 },
  bnb:  { chain: bsc,     rpc: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,  id: 56   },
}

// ---- crypto helpers -------------------------------------------------------

function deriveKey(userId) {
  const master = process.env.WALLET_ENCRYPTION_KEY
  if (!master) throw new Error('WALLET_ENCRYPTION_KEY not set')
  return crypto.pbkdf2Sync(master, userId, 100_000, 32, 'sha256')
}

function decryptKey(blob, userId) {
  const key = deriveKey(userId)
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8')
}

// ---- telegram helper -------------------------------------------------------

async function tgNotify(chatId, text) {
  if (!BOT_TOKEN || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
  } catch {}
}

// ---- ABI fetching ----------------------------------------------------------

async function fetchVerifiedAbi(address, chainId) {
  if (!ETHERSCAN_KEY) return null
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_KEY}`
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.status === '1' && d.result && d.result !== 'Contract source code not verified') {
      return JSON.parse(d.result)
    }
  } catch {}
  return null
}

function findMintFn(abi) {
  const priority = ['mint', 'publicMint', 'mintPublic', 'allowlistMint', 'presaleMint', 'purchase', 'safeMint']
  const fns = abi.filter(f => f.type === 'function' && ['payable', 'nonpayable'].includes(f.stateMutability))
  for (const name of priority) {
    const fn = fns.find(f => f.name === name)
    if (fn) return fn
  }
  return null
}

// ---- mint execution --------------------------------------------------------

async function executeMintServerSide(project, privateKey, chatId) {
  const chainCfg = CHAIN_CONFIG[project.chain || 'eth']
  if (!chainCfg) throw new Error(`Unsupported chain: ${project.chain}`)

  const account = privateKeyToAccount(privateKey)
  const walletClient = createWalletClient({
    account,
    chain: chainCfg.chain,
    transport: http(chainCfg.rpc),
  })
  const publicClient = createPublicClient({
    chain: chainCfg.chain,
    transport: http(chainCfg.rpc),
  })

  const priceStr = (project.mint_price || '0').replace(/[^0-9.]/g, '') || '0'
  const mintPrice = parseEther(priceStr)
  const quantity = BigInt(project.max_mint || 1)
  const gasLimit = BigInt(project.gas_limit || 200000)
  const totalValue = mintPrice * quantity

  let txHash

  // Try verified ABI first
  const verifiedAbi = await fetchVerifiedAbi(project.contract_address, chainCfg.id)
  if (verifiedAbi) {
    const mintFn = findMintFn(verifiedAbi)
    if (mintFn) {
      const args = mintFn.inputs?.length > 0 ? [quantity] : []
      try {
        txHash = await walletClient.writeContract({
          address: project.contract_address,
          abi: verifiedAbi,
          functionName: mintFn.name,
          args,
          value: totalValue,
          gas: gasLimit,
        })
      } catch (e) {
        if (e.message?.includes('rejected') || e.message?.includes('reverted')) throw e
        // Fall through to guessing
      }
    }
  }

  // Fallback — try common signatures
  if (!txHash) {
    const attempts = [
      { sig: 'function mint(uint256 quantity) payable',           name: 'mint',        args: [quantity] },
      { sig: 'function publicMint(uint256 quantity) payable',     name: 'publicMint',  args: [quantity] },
      { sig: 'function mintPublic(uint256 quantity) payable',     name: 'mintPublic',  args: [quantity] },
      { sig: 'function mint() payable',                           name: 'mint',        args: []         },
      { sig: 'function purchase(uint256 numberOfTokens) payable', name: 'purchase',    args: [quantity] },
      { sig: 'function presaleMint(uint256 quantity) payable',    name: 'presaleMint', args: [quantity] },
    ]

    for (const a of attempts) {
      try {
        txHash = await walletClient.writeContract({
          address: project.contract_address,
          abi: parseAbi([a.sig]),
          functionName: a.name,
          args: a.args,
          value: totalValue,
          gas: gasLimit,
        })
        break
      } catch (e) {
        if (e.message?.includes('reverted')) throw e
        continue
      }
    }
  }

  if (!txHash) throw new Error('No supported mint function found on contract')
  return { txHash, publicClient }
}

// ---- main handler ----------------------------------------------------------

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).end()
  }

  if (!process.env.WALLET_ENCRYPTION_KEY) {
    // Return 200 so cron-job.org doesn't disable — just log the config issue
    return res.status(200).json({ ok: false, error: 'WALLET_ENCRYPTION_KEY not configured' })
  }

  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: false, error: 'Supabase env vars missing' })
  }

  // Find all live projects with auto-mint enabled and a contract address
  const { data: projects, error } = await supabase
    .from('wl_projects')
    .select('id, name, chain, contract_address, mint_price, max_mint, gas_limit, wl_type, user_id, auto_mint_fired')
    .eq('status', 'live')
    .eq('mint_mode', 'auto')
    .not('contract_address', 'is', null)
    .neq('auto_mint_fired', true)  // don't double-fire

  if (error) return res.status(200).json({ ok: false, error: error.message })
  if (!projects?.length) return res.status(200).json({ ok: true, fired: 0 })

  const userIds = [...new Set(projects.map(p => p.user_id))]

  // Fetch minting wallets for all involved users
  const { data: wallets } = await supabase
    .from('minting_wallets')
    .select('user_id, encrypted_key, wallet_address')
    .in('user_id', userIds)

  const walletMap = {}
  wallets?.forEach(w => { walletMap[w.user_id] = w })

  // Fetch Telegram chat IDs
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, telegram_chat_id')
    .in('id', userIds)

  const chatMap = {}
  profiles?.forEach(p => { if (p.telegram_chat_id) chatMap[p.id] = p.telegram_chat_id })

  let fired = 0

  for (const project of projects) {
    const walletRow = walletMap[project.user_id]
    const chatId = chatMap[project.user_id]

    if (!walletRow) {
      // No server wallet configured — skip and optionally notify
      await tgNotify(chatId,
        `⚡ <b>Auto-mint skipped: ${project.name}</b>\n\nNo minting wallet set up. Go to <b>Settings → Minting Wallet</b> in Alpha-Hub to enable server-side auto-mint.`
      )
      continue
    }

    // Mark as fired FIRST to prevent duplicate attempts if this run takes long
    await supabase.from('wl_projects')
      .update({ auto_mint_fired: true })
      .eq('id', project.id)

    try {
      const privateKey = decryptKey(walletRow.encrypted_key, project.user_id)
      const chain = (project.chain || 'eth').toUpperCase()
      const price = project.mint_price || 'Free'

      await tgNotify(chatId,
        `⚡ <b>Auto-minting: ${project.name}</b>\n${chain} · ${price}\nFiring transaction from ${walletRow.wallet_address.slice(0, 10)}...`
      )

      const { txHash, publicClient: pc } = await executeMintServerSide(project, privateKey, chatId)

      // Wait for on-chain confirmation before declaring success
      // Times out after 90s — if still pending, mark as pending not minted
      let confirmed = false
      try {
        const receipt = await Promise.race([
          pc.waitForTransactionReceipt({ hash: txHash }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('receipt timeout')), 90_000))
        ])
        confirmed = receipt.status === 'success'
      } catch {
        // Tx submitted but not confirmed in time — leave status as live so it can be retried
      }

      if (!confirmed) {
        await supabase.from('wl_projects').update({ auto_mint_fired: false }).eq('id', project.id)
        await tgNotify(chatId,
          `⏳ <b>TX submitted but unconfirmed: ${project.name}</b>\n\nTX: <code>${txHash.slice(0, 20)}...</code>\nCheck on-chain and mark manually if needed.`
        )
        continue
      }

      // Confirmed on-chain — now mark minted
      await supabase.from('wl_projects')
        .update({ status: 'minted' })
        .eq('id', project.id)

      await supabase.from('mint_log').insert({
        user_id: project.user_id,
        project_id: project.id,
        wallet_address: walletRow.wallet_address,
        chain: project.chain || 'eth',
        tx_hash: txHash,
        status: 'success',
        executed_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {})

      await supabase.from('notifications').insert({
        user_id: project.user_id,
        type: 'mint_success',
        title: `✅ Auto-Mint Success — ${project.name}`,
        message: `Transaction confirmed on-chain. TX: ${txHash.slice(0, 18)}...`,
        data: { tx_hash: txHash, project_id: project.id },
      }).then(() => {}).catch(() => {})

      await tgNotify(chatId,
        `✅ <b>Auto-Mint Confirmed: ${project.name}</b>\n\nTX: <code>${txHash.slice(0, 20)}...</code>\nWallet: ${walletRow.wallet_address.slice(0, 10)}...`
      )

      fired++

    } catch (e) {
      const msg = e.shortMessage || e.message || 'Unknown error'
      console.error(`auto-mint failed for ${project.id}:`, msg)

      // Always unmark fired so the cron can retry on next run.
      // The project remains 'live' so it will be picked up again.
      // Once it succeeds, status becomes 'minted' and it exits the queue permanently.
      await supabase.from('wl_projects').update({ auto_mint_fired: false }).eq('id', project.id)

      await supabase.from('mint_log').insert({
        user_id: project.user_id,
        project_id: project.id,
        wallet_address: walletRow?.wallet_address || 'server',
        chain: project.chain || 'eth',
        status: 'failed',
        error_message: msg.slice(0, 200),
        executed_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {})

      await tgNotify(chatMap[project.user_id],
        `❌ <b>Auto-Mint Failed: ${project.name}</b>\n\n${msg.slice(0, 150)}`
      )
    }
  }

  res.status(200).json({ ok: true, fired })
}

