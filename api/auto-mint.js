/**
 * Server-side auto-mint cron — runs every minute via Vercel cron.
 * Finds live projects with mint_mode='auto', fires transactions using
 * each user's stored minting wallet. No browser or user interaction required.
 *
 * vercel.json cron: { "path": "/api/auto-mint", "schedule": "* * * * *" }
 * Required env vars: WALLET_ENCRYPTION_KEY, SUPABASE_SERVICE_KEY,
 *                    VITE_SUPABASE_URL, ALCHEMY_API_KEY,
 *                    TELEGRAM_BOT_TOKEN (optional), CRON_SECRET (optional)
 */

import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { createWalletClient, createPublicClient, parseEther, parseAbi, encodeFunctionData, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, base, bsc } from 'viem/chains'
import { fallbackTransport, sanitizeRpcError } from './_lib/rpc.js'

let supabase

function getSupabase() {
  if (supabase) return supabase

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) return null

  supabase = createClient(url, key)
  return supabase
}

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.VITE_ALCHEMY_API_KEY
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || process.env.VITE_ETHERSCAN_API_KEY
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const AUTOMINT_ENABLED = String(process.env.AUTOMINT_ENABLED || '').trim().toLowerCase() === 'true'

const CHAIN_CONFIG = {
  eth:  { chain: mainnet, id: 1    },
  base: { chain: base,    id: 8453 },
  bnb:  { chain: bsc,     id: 56   },
}

const EXECUTION_STATUS = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  PREPARED: 'prepared',
  SIMULATING: 'simulating',
  READY: 'ready',
  EXECUTING: 'executing',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
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

function nowIso() {
  return new Date().toISOString()
}

function safeEth(value, fallback = '0') {
  const clean = String(value ?? fallback).replace(/[^0-9.]/g, '') || fallback
  try {
    return parseEther(clean)
  } catch {
    return parseEther(fallback)
  }
}

function msSince(started) {
  return Math.max(0, Date.now() - started)
}

function buildArgs(fn, quantity, account) {
  const inputs = fn.inputs || []
  if (inputs.length === 0) return []
  if (inputs.length === 1) {
    const input = inputs[0]
    if (input.type?.startsWith('uint')) return [quantity]
    if (input.type === 'address') return [account.address]
  }
  throw new Error('Unsupported mint function inputs')
}

async function safeProjectUpdate(projectId, updates) {
  if (!Object.keys(updates).length) return
  const { error } = await supabase.from('wl_projects').update(updates).eq('id', projectId)
  if (error) console.error('automint project update failed:', error.message)
}

async function markProject(projectId, updates) {
  await safeProjectUpdate(projectId, updates)
}

function safeUserMessage(kind) {
  if (kind === 'simulation') return 'Mint simulation failed. Transaction was not sent.'
  if (kind === 'spend') return 'Mint skipped because max spend was exceeded.'
  if (kind === 'prepare') return 'Mint preparation failed.'
  return 'Automint is temporarily unavailable.'
}

function createClients(chainKey, account) {
  const chainCfg = CHAIN_CONFIG[chainKey || 'eth']
  if (!chainCfg) throw new Error(`Unsupported chain: ${chainKey}`)
  const transport = fallbackTransport(chainKey || 'eth')
  return {
    chainCfg,
    walletClient: createWalletClient({ account, chain: chainCfg.chain, transport }),
    publicClient: createPublicClient({ chain: chainCfg.chain, transport }),
  }
}

async function prepareMintTransaction(project, account) {
  const started = Date.now()
  const chainKey = project.chain || 'eth'
  const chainCfg = CHAIN_CONFIG[chainKey]
  if (!chainCfg) throw new Error('Unsupported chain')
  if (!project.contract_address || !isAddress(project.contract_address)) throw new Error('Invalid contract address')

  const quantity = BigInt(project.max_mint || 1)
  const mintPrice = safeEth(project.mint_price || '0')
  const totalValue = mintPrice * quantity
  const attempts = []

  const verifiedAbi = await fetchVerifiedAbi(project.contract_address, chainCfg.id)
  if (verifiedAbi) {
    const mintFn = findMintFn(verifiedAbi)
    if (mintFn) {
      attempts.push({
        abi: verifiedAbi,
        functionName: mintFn.name,
        args: buildArgs(mintFn, quantity, account),
        source: `abi.${mintFn.name}`,
      })
    }
  }

  attempts.push(
    { abi: parseAbi(['function mint(uint256 quantity) payable']), functionName: 'mint', args: [quantity], source: 'common.mint(uint256)' },
    { abi: parseAbi(['function publicMint(uint256 quantity) payable']), functionName: 'publicMint', args: [quantity], source: 'common.publicMint(uint256)' },
    { abi: parseAbi(['function mintPublic(uint256 quantity) payable']), functionName: 'mintPublic', args: [quantity], source: 'common.mintPublic(uint256)' },
    { abi: parseAbi(['function mint() payable']), functionName: 'mint', args: [], source: 'common.mint()' },
    { abi: parseAbi(['function purchase(uint256 numberOfTokens) payable']), functionName: 'purchase', args: [quantity], source: 'common.purchase(uint256)' },
    { abi: parseAbi(['function presaleMint(uint256 quantity) payable']), functionName: 'presaleMint', args: [quantity], source: 'common.presaleMint(uint256)' },
    { abi: parseAbi(['function allowlistMint(uint256 quantity) payable']), functionName: 'allowlistMint', args: [quantity], source: 'common.allowlistMint(uint256)' },
    { abi: parseAbi(['function safeMint(address to) payable']), functionName: 'safeMint', args: [account.address], source: 'common.safeMint(address)' },
  )

  let lastError
  for (const attempt of attempts) {
    try {
      const data = encodeFunctionData({
        abi: attempt.abi,
        functionName: attempt.functionName,
        args: attempt.args,
      })
      return {
        to: project.contract_address,
        data,
        value: totalValue,
        chainId: chainCfg.id,
        source: attempt.source,
        timeToPrepareMs: msSince(started),
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('No supported mint function found')
}

async function simulatePreparedTransaction(project, account, publicClient, prepared) {
  const started = Date.now()
  await publicClient.call({
    account: account.address,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value,
  })
  const gas = await publicClient.estimateGas({
    account: account.address,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value,
  })
  const gasPrice = await publicClient.getGasPrice()
  return {
    gas,
    gasPrice,
    totalGasCost: gas * gasPrice,
    totalCost: prepared.value + (gas * gasPrice),
    timeToSimulateMs: msSince(started),
  }
}

function assertSpendWithinLimits(project, prepared, simulation) {
  const maxMintPrice = project.max_mint_price ? safeEth(project.max_mint_price) : null
  const maxGasFee = project.max_gas_fee ? safeEth(project.max_gas_fee) : null
  const maxTotalSpend = project.max_total_spend ? safeEth(project.max_total_spend) : null

  if (maxMintPrice && prepared.value > maxMintPrice) throw new Error('max_spend_exceeded')
  if (maxGasFee && simulation.totalGasCost > maxGasFee) throw new Error('max_spend_exceeded')
  if (maxTotalSpend && simulation.totalCost > maxTotalSpend) throw new Error('max_spend_exceeded')
}

// ---- mint execution --------------------------------------------------------

async function executeMintServerSide(project, privateKey, chatId) {
  const chainCfg = CHAIN_CONFIG[project.chain || 'eth']
  if (!chainCfg) throw new Error(`Unsupported chain: ${project.chain}`)

  const account = privateKeyToAccount(privateKey)
  const { walletClient, publicClient } = createClients(project.chain || 'eth', account)

  const prepared = await prepareMintTransaction(project, account)
  await markProject(project.id, {
    execution_status: EXECUTION_STATUS.PREPARED,
    prepared_to: prepared.to,
    prepared_data: prepared.data,
    prepared_value: prepared.value.toString(),
    prepared_chain_id: prepared.chainId,
    prepared_at: nowIso(),
    time_to_prepare_ms: prepared.timeToPrepareMs,
  })

  await markProject(project.id, { execution_status: EXECUTION_STATUS.SIMULATING, simulation_started_at: nowIso() })
  const simulation = await simulatePreparedTransaction(project, account, publicClient, prepared)
  assertSpendWithinLimits(project, prepared, simulation)
  await markProject(project.id, {
    execution_status: EXECUTION_STATUS.READY,
    simulation_status: 'passed',
    simulation_error: null,
    simulated_at: nowIso(),
    gas_estimate: simulation.gas.toString(),
    time_to_simulate_ms: simulation.timeToSimulateMs,
  })

  await markProject(project.id, { execution_status: EXECUTION_STATUS.EXECUTING, execution_started_at: nowIso() })
  const started = Date.now()
  const txHash = await walletClient.sendTransaction({
    account,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value,
    gas: simulation.gas,
  })
  await markProject(project.id, {
    execution_status: EXECUTION_STATUS.SUBMITTED,
    submitted_at: nowIso(),
    time_to_submit_ms: msSince(started),
  })
  return { txHash, publicClient }
}

// ---- main handler ----------------------------------------------------------

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).end()
  }

  if (!AUTOMINT_ENABLED) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      fired: 0,
      message: 'Automint disabled by global safety switch',
    })
  }

  if (!process.env.WALLET_ENCRYPTION_KEY) {
    // Return 200 so cron-job.org doesn't disable — just log the config issue
    return res.status(200).json({ ok: false, error: 'WALLET_ENCRYPTION_KEY not configured' })
  }

  supabase = getSupabase()

  if (!supabase) {
    return res.status(200).json({ ok: false, error: 'Supabase env vars missing' })
  }

  // Find all live projects with auto-mint enabled and a contract address.
  // Select * so new safety columns can be used when present without breaking older schemas.
  const { data: projects, error } = await supabase
    .from('wl_projects')
    .select('*')
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

    if (project.automint_enabled === false) {
      await markProject(project.id, {
        execution_status: EXECUTION_STATUS.SKIPPED,
        execution_reason: 'automint_not_enabled',
      })
      continue
    }

    if (project.mint_time_confirmed === false) {
      await markProject(project.id, {
        execution_status: EXECUTION_STATUS.SKIPPED,
        execution_reason: 'mint_time_not_confirmed',
      })
      await tgNotify(chatId, `⚠️ <b>Auto-mint skipped: ${project.name}</b>\n\nMint time not confirmed.`)
      continue
    }

    if (!project.contract_address || !isAddress(project.contract_address)) {
      await markProject(project.id, {
        execution_status: EXECUTION_STATUS.SKIPPED,
        execution_reason: 'missing_contract',
      })
      await tgNotify(chatId, `⚠️ <b>Auto-mint skipped: ${project.name}</b>\n\nMissing contract address.`)
      continue
    }

    if (!walletRow) {
      // No server wallet configured — skip and optionally notify
      await markProject(project.id, {
        execution_status: EXECUTION_STATUS.SKIPPED,
        execution_reason: 'missing_minting_wallet',
      })
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

      await markProject(project.id, { execution_status: EXECUTION_STATUS.PREPARING, prepare_started_at: nowIso() })
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
        await markProject(project.id, {
          execution_status: EXECUTION_STATUS.SUBMITTED,
          execution_reason: 'confirmation_timeout',
        })
        await tgNotify(chatId,
          `⏳ <b>TX submitted but unconfirmed: ${project.name}</b>\n\nTX: <code>${txHash.slice(0, 20)}...</code>\nCheck on-chain and mark manually if needed.`
        )
        continue
      }

      // Confirmed on-chain — now mark minted
      await supabase.from('wl_projects')
        .update({ status: 'minted' })
        .eq('id', project.id)
      await markProject(project.id, {
        execution_status: EXECUTION_STATUS.CONFIRMED,
        confirmed_at: nowIso(),
      })

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
      const isSpend = msg === 'max_spend_exceeded'
      const publicMsg = isSpend ? safeUserMessage('spend') : sanitizeRpcError(e)

      // Always unmark fired so the cron can retry on next run.
      // The project remains 'live' so it will be picked up again.
      // Once it succeeds, status becomes 'minted' and it exits the queue permanently.
      await supabase.from('wl_projects').update({ auto_mint_fired: false }).eq('id', project.id)
      await markProject(project.id, {
        execution_status: isSpend ? EXECUTION_STATUS.SKIPPED : EXECUTION_STATUS.FAILED,
        execution_reason: isSpend ? 'max_spend_exceeded' : 'execution_failed',
        simulation_status: isSpend ? 'passed' : 'failed',
        simulation_error: publicMsg,
      })

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
        `❌ <b>Auto-Mint Failed: ${project.name}</b>\n\n${publicMsg}`
      )
    }
  }

  res.status(200).json({ ok: true, fired })
}
