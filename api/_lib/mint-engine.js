import { createPublicClient, encodeFunctionData, http, isAddress, parseAbi, parseEther } from 'viem'
import { createServiceClient, requireUser } from './auth.js'
import { rateLimit, sendRateLimit } from './redis.js'
import { chainIdFor, normalizeChain, normalizePhase, recommendMode } from './project-intelligence.js'

const SUPPORTED_EXECUTION_CHAINS = new Set(['eth', 'base', 'apechain'])
const AUTO_STRIKE_ENABLED = String(process.env.AUTO_STRIKE_ENABLED || '').toLowerCase() === 'true'
const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'
const MINT_NAMES = ['mint', 'publicMint', 'mintPublic', 'allowlistMint', 'presaleMint', 'purchase', 'claim', 'buy', 'safeMint']
const RPC_URLS = {
  eth: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  apechain: process.env.APECHAIN_RPC_URL || '',
}
const EXPLORER_CHAIN_NAMES = {
  eth: 'Ethereum',
  base: 'Base',
  apechain: 'ApeChain',
}

const EVENT_MESSAGES = {
  preparing: 'Preparing project',
  phase: 'Detecting phase',
  checking: 'Checking contract',
  prepared: 'Preparing transaction',
  simulating: 'Simulating mint',
  gas: 'Gas locked',
  watching: 'Watching mint window',
  stopped: 'Stopped',
}

function safeError(message = 'Mint action is temporarily unavailable.') {
  return { ok: false, error: message }
}

function safeMessage(error) {
  const msg = String(error?.shortMessage || error?.message || error || '').toLowerCase()
  if (msg.includes('contract address')) return 'Contract address is needed for Fast or Strike Mint.'
  if (msg.includes('connect wallet')) return 'Connect wallet before preparing this mint.'
  if (msg.includes('no contract exists')) return 'No contract exists at this address on the selected chain.'
  if (msg.includes('rpc')) return 'Mint preparation needs a working RPC for this chain.'
  if (msg.includes('max_spend_exceeded')) return 'Mint skipped because max spend was exceeded.'
  if (msg.includes('insufficient funds')) return 'The mint wallet does not have enough funds.'
  if (msg.includes('execution reverted') || msg.includes('revert')) return 'Mint simulation failed. The transaction was not sent.'
  if (msg.includes('function') || msg.includes('selector')) return 'Unknown mint function. Use the official mint site or add contract details.'
  if (msg.includes('chain')) return 'Wrong chain for this mint.'
  return 'Mint preparation failed. Nothing was sent.'
}

function chainObject(chain) {
  const id = chainIdFor(chain)
  return {
    id,
    name: EXPLORER_CHAIN_NAMES[chain] || chain,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URLS[chain]].filter(Boolean) } },
  }
}

function publicClient(chain) {
  const url = RPC_URLS[chain]
  if (!url) return null
  return createPublicClient({ chain: chainObject(chain), transport: http(url, { timeout: 9000 }) })
}

function cleanPrice(value) {
  const raw = String(value || '0').replace(/[^0-9.]/g, '')
  return raw && Number.isFinite(Number(raw)) ? raw : '0'
}

function spendLimitWei(body) {
  const raw = cleanPrice(body.maxTotalSpend || body.max_total_spend)
  if (!raw || Number(raw) <= 0) return null
  return parseEther(raw)
}

async function fetchVerifiedAbi(contractAddress, chain) {
  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.VITE_ETHERSCAN_API_KEY || ''
  if (!apiKey) return null
  const chainId = chainIdFor(chain)
  const url = new URL('https://api.etherscan.io/v2/api')
  url.searchParams.set('chainid', String(chainId))
  url.searchParams.set('module', 'contract')
  url.searchParams.set('action', 'getabi')
  url.searchParams.set('address', contractAddress)
  url.searchParams.set('apikey', apiKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const data = await response.json()
    if (data?.status === '1' && data?.result && !String(data.result).includes('not verified')) {
      return JSON.parse(data.result)
    }
  } finally {
    clearTimeout(timer)
  }
  return null
}

function isUint(input) {
  return /^uint/.test(String(input?.type || ''))
}

function isAddressInput(input) {
  return String(input?.type || '') === 'address'
}

function argsForInputs(inputs = [], quantity, walletAddress) {
  if (!inputs.length) return []
  if (inputs.length === 1) {
    if (isUint(inputs[0])) return [quantity]
    if (isAddressInput(inputs[0])) return [walletAddress]
  }
  if (inputs.length === 2) {
    if (isAddressInput(inputs[0]) && isUint(inputs[1])) return [walletAddress, quantity]
    if (isUint(inputs[0]) && isAddressInput(inputs[1])) return [quantity, walletAddress]
    if (isUint(inputs[0]) && isUint(inputs[1])) return [quantity, 0n]
  }
  return null
}

function candidatesFromAbi(abi, quantity, walletAddress) {
  if (!Array.isArray(abi)) return []
  return abi
    .filter(fn => fn?.type === 'function' && MINT_NAMES.some(name => String(fn.name || '').toLowerCase() === name.toLowerCase()))
    .map(fn => {
      const args = argsForInputs(fn.inputs || [], quantity, walletAddress)
      if (!args) return null
      return { abi, functionName: fn.name, args, source: 'verified_abi' }
    })
    .filter(Boolean)
}

function fallbackCandidates(quantity, walletAddress) {
  return [
    { sig: 'function mint(uint256 quantity) payable', name: 'mint', args: [quantity] },
    { sig: 'function publicMint(uint256 quantity) payable', name: 'publicMint', args: [quantity] },
    { sig: 'function mintPublic(uint256 quantity) payable', name: 'mintPublic', args: [quantity] },
    { sig: 'function allowlistMint(uint256 quantity) payable', name: 'allowlistMint', args: [quantity] },
    { sig: 'function presaleMint(uint256 quantity) payable', name: 'presaleMint', args: [quantity] },
    { sig: 'function purchase(uint256 numberOfTokens) payable', name: 'purchase', args: [quantity] },
    { sig: 'function claim(uint256 quantity) payable', name: 'claim', args: [quantity] },
    { sig: 'function mint() payable', name: 'mint', args: [] },
    { sig: 'function claim() payable', name: 'claim', args: [] },
    { sig: 'function safeMint(address to) payable', name: 'safeMint', args: [walletAddress] },
  ].map(item => ({
    abi: parseAbi([item.sig]),
    functionName: item.name,
    args: item.args,
    source: 'common_signature',
  }))
}

export async function prepareMintTransaction(body) {
  const chain = normalizeChain(body.chain)
  const chainId = chainIdFor(chain)
  const contract = body.contractAddress || body.contract_address
  const walletAddress = body.walletAddress || body.wallet_address || body.account
  if (!contract || !isAddress(contract)) throw new Error('Contract address is required for Fast Mint.')
  if (!walletAddress || !isAddress(walletAddress)) throw new Error('Connect wallet before preparing this mint.')
  const client = publicClient(chain)
  if (!client) throw new Error('Mint preparation needs RPC configured for this chain.')

  const code = await client.getBytecode({ address: contract })
  if (!code || code === '0x') throw new Error('No contract exists at this address on the selected chain.')

  const quantity = BigInt(Math.max(1, Number(body.quantity || body.max_mint || 1)))
  const value = parseEther(cleanPrice(body.mintPrice || body.mint_price || body.price)) * quantity
  const maxSpend = spendLimitWei(body)
  const verifiedAbi = await fetchVerifiedAbi(contract, chain).catch(() => null)
  const candidates = [
    ...candidatesFromAbi(verifiedAbi, quantity, walletAddress),
    ...fallbackCandidates(quantity, walletAddress),
  ]

  let lastError = null
  for (const candidate of candidates) {
    try {
      const data = encodeFunctionData({
        abi: candidate.abi,
        functionName: candidate.functionName,
        args: candidate.args,
      })
      const gas = await client.estimateGas({
        account: walletAddress,
        to: contract,
        data,
        value,
      })
      if (maxSpend) {
        const gasPrice = await client.getGasPrice().catch(() => 0n)
        const estimatedTotal = value + (gas * gasPrice)
        if (estimatedTotal > maxSpend) throw new Error('max_spend_exceeded')
      }
      return {
        to: contract,
        data,
        value: value.toString(),
        chainId,
        gas: gas.toString(),
        functionName: candidate.functionName,
        argsSummary: candidate.args.map(arg => typeof arg === 'bigint' ? arg.toString() : String(arg)),
        source: candidate.source,
      }
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(safeMessage(lastError))
}

function intentPayload(user, body, status = 'draft') {
  const chain = normalizeChain(body.chain)
  const phase = normalizePhase(body.phase || body.mintPhase)
  const risk = Number(body.riskScore || 50)
  const mode = body.mode || recommendMode(phase, risk)
  return {
    user_id: user.id,
    project_id: body.projectId || null,
    calendar_project_id: body.calendarProjectId || null,
    wl_project_id: body.wlProjectId || null,
    project_name: body.name || body.projectName || 'Mint project',
    contract_address: body.contractAddress || body.contract_address || null,
    chain,
    chain_id: chainIdFor(chain),
    mint_url: body.mintUrl || body.mint_url || null,
    mint_phase: phase,
    execution_mode: mode,
    quantity: Number(body.quantity || 1),
    max_mint_price: body.maxMintPrice || body.max_mint_price || null,
    max_gas_fee: body.maxGasFee || body.max_gas_fee || null,
    max_total_spend: body.maxTotalSpend || body.max_total_spend || null,
    status,
    last_state: status === 'prepared' ? EVENT_MESSAGES.prepared : EVENT_MESSAGES.preparing,
    updated_at: new Date().toISOString(),
  }
}

async function insertOptional(supabase, table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single()
  if (!error) return data
  const msg = String(error.message || '').toLowerCase()
  if (msg.includes('schema') || msg.includes('relation') || msg.includes('column')) return { ...row, localOnly: true }
  throw error
}

async function logEvent(supabase, intentId, userId, state, message, metadata = {}) {
  if (!intentId || String(intentId).startsWith('local-')) return null
  try {
    await supabase.from('mint_execution_events').insert({
      intent_id: intentId,
      user_id: userId,
      state,
      message: message || EVENT_MESSAGES[state] || state,
      metadata,
    })
  } catch {}
}

async function loadIntent(supabase, userId, intentId) {
  const { data, error } = await supabase
    .from('mint_intents')
    .select('*')
    .eq('id', intentId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function loadAttempts(supabase, intentId) {
  const { data, error } = await supabase
    .from('mint_attempts')
    .select('*')
    .or(`intent_id.eq.${intentId},mint_intent_id.eq.${intentId}`)
    .order('created_at', { ascending: true })
  if (error) return []
  return data || []
}

async function recordAttempt(supabase, intentId, userId, status, metadata = {}) {
  if (!intentId || String(intentId).startsWith('local-')) return null
  try {
    const { data, error } = await supabase.from('mint_attempts').insert({
      intent_id: intentId,
      mint_intent_id: intentId,
      user_id: userId,
      status,
      metadata,
    }).select().single()
    if (!error) return data
  } catch {}
  return null
}

async function updateStrikeIntent(supabase, intentId, userId, payload) {
  const fullPayload = {
    ...payload,
    strike_status: 'armed',
    status: 'armed',
    updated_at: new Date().toISOString(),
  }
  let { data, error } = await supabase
    .from('mint_intents')
    .update(fullPayload)
    .eq('id', intentId)
    .eq('user_id', userId)
    .select()
    .single()
  if (!error) return data

  const message = String(error.message || '').toLowerCase()
  if (message.includes('schema cache') || message.includes('column') || message.includes('strike_status') || message.includes('strike_execute_at') || message.includes('vault_wallet_id')) {
    const { strike_status, strike_execute_at, vault_wallet_id, max_gas_fee, quantity, ...safePayload } = fullPayload
    const retry = await supabase
      .from('mint_intents')
      .update(safePayload)
      .eq('id', intentId)
      .eq('user_id', userId)
      .select()
      .single()
    data = retry.data
    error = retry.error
  }
  if (error) throw error
  return data
}

async function loadVault(supabase, userId) {
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id,address,wallet_address,status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
  if (error) return false
  return data?.[0] || null
}

export async function handleMintAction(req, res, action) {
  const allowed = new Set(['prepare', 'enable-strike', 'stop', 'execute', 'confirm', 'status'])
  if (!allowed.has(action)) return res.status(404).json(safeError('Unknown mint action.'))

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:mint:${action}:${user.id}`, 30, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  const supabase = createServiceClient()

  try {
    if (action === 'status') {
      const intentId = req.query.intentId || req.body?.intentId
      if (!intentId) return res.status(400).json(safeError('Mint session not found.'))
      const intent = await loadIntent(supabase, user.id, intentId)
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      const { data: events } = await supabase
        .from('mint_execution_events')
        .select('*')
        .eq('intent_id', intentId)
        .order('created_at', { ascending: true })
      const attempts = await loadAttempts(supabase, intentId)
      return res.status(200).json({ ok: true, intent, events: events || [], attempts })
    }

    if (action === 'prepare') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const chain = normalizeChain(body.chain)
      if (!SUPPORTED_EXECUTION_CHAINS.has(chain)) return res.status(400).json(safeError('This chain is discovery-only for now.'))
      const contract = body.contractAddress || body.contract_address
      if (contract && !isAddress(contract)) return res.status(400).json(safeError('This contract address does not look right.'))
      let preparedTransaction
      try {
        preparedTransaction = await prepareMintTransaction(body)
      } catch (error) {
        return res.status(400).json(safeError(safeMessage(error)))
      }
      const row = await insertOptional(supabase, 'mint_intents', intentPayload(user, body, 'prepared'))
      const intentId = row.id || `local-${Date.now()}`
      await logEvent(supabase, intentId, user.id, 'preparing')
      await logEvent(supabase, intentId, user.id, 'phase')
      await logEvent(supabase, intentId, user.id, 'checking')
      await logEvent(supabase, intentId, user.id, 'prepared')
      return res.status(200).json({
        ok: true,
        intent: { ...row, id: intentId },
        mode: body.mode || row.execution_mode || 'safe',
        preparedTransaction,
        message: 'Mint prepared and simulated. Confirm in your wallet when ready.',
      })
    }

    if (action === 'enable-strike') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const { acknowledgeRisk, maxTotalSpend } = body
      let { intentId } = body
      if (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED) {
        return res.status(200).json({ ok: true, dryRun: true, error: 'Strike Mode is disabled by the global safety switch.' })
      }
      if (!acknowledgeRisk) return res.status(400).json(safeError('Confirm Strike Mode warnings before enabling.'))
      if (!maxTotalSpend) return res.status(400).json(safeError('Set a max spend limit before enabling Strike Mode.'))
      const vault = await loadVault(supabase, user.id)
      if (!vault) return res.status(400).json(safeError('Create or import an Alpha Vault wallet before Strike Mode.'))
      if (!intentId) {
        const created = await insertOptional(supabase, 'mint_intents', intentPayload(user, {
          ...body,
          mode: 'strike',
          maxTotalSpend,
        }, 'prepared'))
        intentId = created.id
      }
      const intent = await loadIntent(supabase, user.id, intentId)
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      if (!intent.contract_address) return res.status(400).json(safeError('Strike Mode needs a contract address.'))
      if (!SUPPORTED_EXECUTION_CHAINS.has(intent.chain)) return res.status(400).json(safeError('This chain is not supported for Strike Mode yet.'))
      try {
        await prepareMintTransaction({ ...intent, walletAddress: vault.address || vault.wallet_address })
      } catch (error) {
        return res.status(400).json(safeError(safeMessage(error)))
      }
      const strikeExecuteAt = body.strikeExecuteAt || body.strike_execute_at || body.mintDate || intent.mint_date || new Date().toISOString()
      const armed = await updateStrikeIntent(supabase, intentId, user.id, {
        execution_mode: 'strike',
        max_total_spend: maxTotalSpend,
        max_gas_fee: body.maxGasFee || body.max_gas_fee || intent.max_gas_fee || null,
        quantity: Number(body.quantity || intent.quantity || 1),
        vault_wallet_id: vault.id,
        strike_execute_at: strikeExecuteAt,
        strike_enabled: true,
        last_state: EVENT_MESSAGES.watching,
      })
      console.log('Strike intent armed', intentId)
      await logEvent(supabase, intentId, user.id, 'watching', 'Strike armed. Worker is watching.', {
        vaultWalletId: vault.id,
        strikeExecuteAt,
      })
      return res.status(200).json({ ok: true, intent: armed, message: 'Strike armed. Worker is watching.' })
    }

    if (action === 'stop') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const { intentId } = req.body || {}
      if (!intentId) return res.status(400).json(safeError('Mint session not found.'))
      await supabase.from('mint_intents').update({
        status: 'stopped',
        strike_enabled: false,
        last_state: EVENT_MESSAGES.stopped,
        updated_at: new Date().toISOString(),
      }).eq('id', intentId).eq('user_id', user.id)
      await logEvent(supabase, intentId, user.id, 'stopped')
      await recordAttempt(supabase, intentId, user.id, 'stopped')
      return res.status(200).json({ ok: true, message: 'Mint stopped.' })
    }

    if (action === 'execute' || action === 'confirm') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const { intentId, mode = 'safe' } = req.body || {}
      const intent = intentId ? await loadIntent(supabase, user.id, intentId) : null
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      if (mode === 'strike' || intent.execution_mode === 'strike') {
        return res.status(400).json(safeError('Strike execution is guarded by the Auto Strike worker and safety switches.'))
      }
      await logEvent(supabase, intentId, user.id, 'simulating')
      await logEvent(supabase, intentId, user.id, 'gas')
      await recordAttempt(supabase, intentId, user.id, 'wallet_confirmation_ready', { mode })
      let preparedTransaction
      try {
        preparedTransaction = await prepareMintTransaction({ ...intent, walletAddress: req.body?.walletAddress, mode })
      } catch (error) {
        return res.status(400).json(safeError(safeMessage(error)))
      }
      return res.status(200).json({
        ok: true,
        requiresWalletConfirmation: true,
        message: mode === 'fast' ? 'Fast Mint is ready. Confirm in your wallet.' : 'Safe Mint is ready. Confirm in your wallet.',
        transaction: preparedTransaction,
      })
    }
  } catch (error) {
    console.error(`mint ${action} failed:`, error)
    return res.status(200).json(safeError('Mint engine is temporarily unavailable. Nothing was sent.'))
  }
}
