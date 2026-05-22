import { createPublicClient, encodeFunctionData, http, isAddress, parseAbi, parseEther } from 'viem'
import { createServiceClient, requireUser } from './auth.js'
import { rateLimit, sendRateLimit } from './redis.js'
import { chainIdFor, normalizeChain, normalizePhase, recommendMode } from './project-intelligence.js'
import {
  getCachedAbi, setCachedAbi,
  getCachedExecution, setCachedExecution, loadCachedExecution,
  recordLatency, getPrewarmStatus,
} from './contract-cache.js'
import { computeReadiness } from './readiness.js'
import {
  gasFromProfile,
  loadExecutionProfile,
  optimizationTelemetry,
  readinessBoostFromProfile,
  recordExecutionOptimization,
  rpcLabelForUrl,
  rpcTimeoutMs,
} from './execution-optimizer.js'

const SUPPORTED_EXECUTION_CHAINS = new Set(['eth', 'base', 'apechain', 'bnb', 'sepolia', 'base-sepolia'])
const AUTO_STRIKE_ENABLED = String(process.env.AUTO_STRIKE_ENABLED || '').toLowerCase() === 'true'
const ALPHA_VAULT_ENABLED = String(process.env.ALPHA_VAULT_ENABLED || '').toLowerCase() === 'true'
const MINT_NAMES = ['mint', 'publicMint', 'mintPublic', 'allowlistMint', 'presaleMint', 'purchase', 'claim', 'buy', 'safeMint', 'mintNFT', 'freeMint']

// SeaDrop: OpenSea's public mint router — NFT contracts that use SeaDrop can only be minted
// via the SeaDrop contract calling mintPublic(nftContract, feeRecipient, minterIfNotPayer, qty)
const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
const SEADROP_ABI = parseAbi([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)',
])
// Known reliable OpenSea fee recipient — fallback if on-chain query fails
const SEADROP_FEE_RECIPIENT_FALLBACK = '0x0000a26b00c1F0DF003000390027140000fAa719'
const RPC_URLS = {
  eth: process.env.ETH_RPC_URL || 'https://ethereum.publicnode.com',
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  apechain: process.env.APECHAIN_RPC_URL || '',
  bnb: process.env.BNB_RPC_URL || 'https://bsc-dataseed.binance.org',
  sepolia: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
}
// Fallback RPC URLs tried in order when the primary fails with a network/HTTP error
const RPC_FALLBACKS = {
  eth:  ['https://cloudflare-eth.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  base: ['https://base.drpc.org', 'https://1rpc.io/base'],
  bnb:  ['https://bsc-dataseed1.binance.org', 'https://bsc-dataseed2.binance.org'],
  sepolia: ['https://sepolia.drpc.org', 'https://1rpc.io/sepolia'],
  'base-sepolia': ['https://base-sepolia.drpc.org'],
}
const EXPLORER_CHAIN_NAMES = {
  eth: 'Ethereum',
  base: 'Base',
  apechain: 'ApeChain',
  bnb: 'BNB Chain',
  sepolia: 'Sepolia',
  'base-sepolia': 'Base Sepolia',
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeError(message = 'Mint action is temporarily unavailable.') {
  return { ok: false, error: message }
}

function normalizeOptionalUuid(value) {
  if (value === undefined || value === null) return null
  const raw = String(value).trim()
  if (!raw || raw.toLowerCase() === 'undefined' || raw.toLowerCase() === 'null') return null
  return UUID_RE.test(raw) ? raw : null
}

function hasRealValue(value) {
  if (value === undefined || value === null) return false
  const raw = String(value).trim().toLowerCase()
  return Boolean(raw && raw !== 'undefined' && raw !== 'null')
}

function normalizeOptionalText(value) {
  return hasRealValue(value) ? String(value).trim() : null
}

function validateRequiredUuid(value, label) {
  const normalized = normalizeOptionalUuid(value)
  if (!normalized) throw new Error(`${label} is invalid.`)
  return normalized
}

function compactPayload(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
}

function logSanitizedPayload(label, row) {
  console.log(label, {
    project_id: row.project_id,
    calendar_project_id: row.calendar_project_id,
    wl_project_id: row.wl_project_id,
    contract_address: row.contract_address,
    chain: row.chain,
    status: row.status,
    strike_enabled: row.strike_enabled,
    strike_status: row.strike_status,
    strike_armed_at: row.strike_armed_at,
    strike_execute_at: row.strike_execute_at,
    strike_error: row.strike_error,
    vault_wallet_id: row.vault_wallet_id,
  })
}

function safeMessage(error) {
  const msg = String(error?.shortMessage || error?.message || error || '').toLowerCase()
  if (msg.includes('contract address')) return 'Contract address is needed for Fast or Strike Mint.'
  if (msg.includes('connect wallet')) return 'Connect wallet before preparing this mint.'
  if (msg.includes('no contract exists') || msg.includes('no bytecode') || msg.includes('contract not found')) return 'No contract found at this address on the selected chain. Check the contract address.'
  if (msg.includes('rpc') || msg.includes('http request failed') || msg.includes('fetch failed') || msg.includes('network error') || msg.includes('econnrefused') || msg.includes('etimedout')) return 'RPC connection failed. Please retry in a moment.'
  if (msg.includes('max_spend_exceeded')) return 'Mint skipped — max spend limit reached.'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'Request timed out. Please try again.'
  if (msg.includes('nonce')) return 'Transaction nonce error — reset your wallet pending transactions and try again.'
  if (msg.includes('insufficient funds') || msg.includes('total cost') || msg.includes('exceeds the balance') || msg.includes('exceeds balance')) return 'Insufficient ETH — top up your wallet and try again.'
  if (msg.includes('seadrop mint not active') || msg.includes('public drop not configured') || msg.includes('not currently active')) return 'This mint is not currently active — the public drop is not open yet. Check the official mint page.'
  if (msg.includes('sale not active') || msg.includes('sale is not active') || msg.includes('not started') || msg.includes('not open') || msg.includes('mint closed') || msg.includes('mint has not') || msg.includes('minting is not') || msg.includes('paused')) return 'Mint is not open yet or has ended. Check the official mint page for the correct time.'
  if (msg.includes('allowlist') || msg.includes('not whitelisted') || msg.includes('not eligible') || msg.includes('merkle') || msg.includes('not in whitelist')) return 'Mint rejected — your wallet is not on the allowlist for this phase.'
  if (msg.includes('already minted') || msg.includes('max per wallet') || msg.includes('max mint') || msg.includes('limit reached') || msg.includes('max tokens') || msg.includes('token limit')) return 'Max mints reached — this wallet has hit the limit for this mint.'
  if (msg.includes('max supply') || msg.includes('sold out') || msg.includes('exceeds max') || msg.includes('supply exceeded')) return 'Sold out — this mint has reached maximum supply.'
  if (msg.includes('msg.value') || msg.includes('wrong value') || msg.includes('incorrect value') || msg.includes('invalid price') || msg.includes('price mismatch')) return 'Wrong mint price — check the price on the official mint page.'
  if (msg.includes('execution reverted') || msg.includes('revert')) return 'Mint simulation failed — contract rejected the transaction. The mint may be closed or require an allowlist.'
  if (msg.includes('function') || msg.includes('selector') || msg.includes('unknown mint') || msg.includes('no standard mint')) return 'Could not detect the mint function. Use the official mint site or add contract details.'
  if (msg.includes('chain') || msg.includes('network')) return 'Wrong chain — switch to the required network and try again.'
  if (msg.includes('erc721a') || msg.includes('mint_erc2309') || msg.includes('transferhelper') || msg.includes('ownable') || msg.includes('caller is not the owner')) return 'Contract configuration rejected the mint.'
  if (msg.includes('invalid proof') || msg.includes('proof verification failed')) return 'Allowlist proof invalid for this wallet.'
  if (msg.includes('cannot estimate gas') || msg.includes('estimategas') || msg.includes('gas estimation')) return 'Gas estimation failed — mint may not be live yet.'
  if (msg.includes('user operation') || msg.includes('aa23') || msg.includes('aa24')) return 'Smart wallet execution failed.'
  if (msg.includes('429') || msg.includes('too many requests')) return 'RPC is rate limited — retry in a few seconds.'
  const raw = String(error?.shortMessage || error?.message || error || 'Unknown mint error')
  console.error('[mint-safeMessage-unmatched]', { raw_error: raw })
  return raw.length > 180 ? raw.slice(0, 180) : raw
}

function chainObject(chain) {
  const id = chainIdFor(chain)
  return {
    id,
    name: EXPLORER_CHAIN_NAMES[chain] || chain,
    nativeCurrency: chain === 'bnb'
      ? { name: 'BNB', symbol: 'BNB', decimals: 18 }
      : { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URLS[chain]].filter(Boolean) } },
  }
}

function isRpcFailure(error) {
  const msg = String(error?.message || error || '').toLowerCase()
  return msg.includes('http request failed') || msg.includes('fetch failed') || msg.includes('network error') || msg.includes('econnrefused') || msg.includes('etimedout')
}

function publicClient(chain, rpcUrl, executionProfile) {
  const url = rpcUrl || RPC_URLS[chain]
  if (!url) return null
  return createPublicClient({ chain: chainObject(chain), transport: http(url, { timeout: rpcTimeoutMs(executionProfile, 9000) }) })
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
  const cached = getCachedAbi(contractAddress, chain)
  if (cached) return cached

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
      const abi = JSON.parse(data.result)
      setCachedAbi(contractAddress, chain, abi)
      return abi
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

function defaultForType(type) {
  const t = String(type || '')
  if (/^uint/.test(t) || /^int/.test(t)) return 0n
  if (t === 'address') return '0x0000000000000000000000000000000000000000'
  if (t === 'bool') return false
  if (t === 'string') return ''
  if (/^bytes/.test(t)) return '0x'  // bytes, bytes32, bytes calldata, etc.
  if (t.endsWith('[]')) return []
  return null  // tuple or unknown — can't safely guess
}

export function argsForInputs(inputs = [], quantity, walletAddress) {
  if (!inputs.length) return []
  // Build args type-by-type, substituting quantity for the first uint and walletAddress for address
  let usedQuantity = false
  const args = []
  for (const input of inputs) {
    const t = String(input?.type || '')
    if (/^uint/.test(t) || /^int/.test(t)) {
      args.push(usedQuantity ? 0n : quantity)
      usedQuantity = true
    } else if (t === 'address') {
      args.push(walletAddress)
    } else {
      const def = defaultForType(t)
      if (def === null) return null  // tuple or unknown composite — skip this function
      args.push(def)
    }
  }
  return args
}

export function candidatesFromAbi(abi, quantity, walletAddress) {
  if (!Array.isArray(abi)) return []
  const results = []
  for (const fn of abi) {
    if (fn?.type !== 'function') continue
    const nameMatch = MINT_NAMES.some(n => String(fn.name || '').toLowerCase() === n.toLowerCase())
    if (!nameMatch) continue
    const args = argsForInputs(fn.inputs || [], quantity, walletAddress)
    if (args === null) {
      console.log('[mint-benchmark] abi_candidate_skip', {
        fn: fn.name,
        inputs: (fn.inputs || []).map(i => i.type),
        reason: 'argsForInputs_null',
      })
      continue
    }
    results.push({ abi, functionName: fn.name, args, source: 'verified_abi' })
  }
  // Log the first few non-mint function names so we can spot naming mismatches
  const allFnNames = abi.filter(f => f?.type === 'function').map(f => f.name)
  if (results.length === 0) {
    console.log('[mint-benchmark] abi_no_candidates', {
      allFunctions: allFnNames.slice(0, 20),
    })
  }
  return results
}

export function fallbackCandidates(quantity, walletAddress) {
  return [
    { sig: 'function mint(uint256 quantity) payable', name: 'mint', args: [quantity] },
    { sig: 'function publicMint(uint256 quantity) payable', name: 'publicMint', args: [quantity] },
    { sig: 'function mintPublic(uint256 quantity) payable', name: 'mintPublic', args: [quantity] },
    { sig: 'function allowlistMint(uint256 quantity) payable', name: 'allowlistMint', args: [quantity] },
    { sig: 'function presaleMint(uint256 quantity) payable', name: 'presaleMint', args: [quantity] },
    { sig: 'function purchase(uint256 numberOfTokens) payable', name: 'purchase', args: [quantity] },
    { sig: 'function claim(uint256 quantity) payable', name: 'claim', args: [quantity] },
    { sig: 'function mintNFT(uint256 quantity) payable', name: 'mintNFT', args: [quantity] },
    { sig: 'function freeMint(uint256 quantity) payable', name: 'freeMint', args: [quantity] },
    { sig: 'function mint() payable', name: 'mint', args: [] },
    { sig: 'function claim() payable', name: 'claim', args: [] },
    { sig: 'function mintNFT() payable', name: 'mintNFT', args: [] },
    { sig: 'function freeMint() payable', name: 'freeMint', args: [] },
    { sig: 'function safeMint(address to) payable', name: 'safeMint', args: [walletAddress] },
  ].map(item => ({
    abi: parseAbi([item.sig]),
    functionName: item.name,
    args: item.args,
    source: 'common_signature',
  }))
}

function isSeaDropContract(abi) {
  return Array.isArray(abi) && abi.some(fn => fn?.type === 'function' && fn.name === 'mintSeaDrop')
}

async function buildSeaDropCandidates(nftContract, quantity, walletAddress, client) {
  const [feeResult, dropResult] = await Promise.allSettled([
    client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getAllowedFeeRecipients', args: [nftContract] }),
    client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getPublicDrop', args: [nftContract] }),
  ])
  const feeRecipients = feeResult.status === 'fulfilled' ? feeResult.value : []
  const feeRecipient = feeRecipients[0] || SEADROP_FEE_RECIPIENT_FALLBACK
  const drop = dropResult.status === 'fulfilled' ? dropResult.value : null
  const mintPrice = drop ? BigInt(drop.mintPrice || 0n) : 0n
  const totalValue = mintPrice * quantity
  const now = BigInt(Math.floor(Date.now() / 1000))
  const startTime = drop ? BigInt(drop.startTime || 0n) : 0n
  const endTime = drop ? BigInt(drop.endTime || 0n) : 0n
  const isActive = startTime > 0n && startTime <= now && (endTime === 0n || endTime > now)
  console.log('[mint-benchmark] seadrop_detected', {
    nftContract: nftContract.slice(0, 10),
    feeRecipient: feeRecipient.slice(0, 10),
    mintPrice: mintPrice.toString(),
    startTime: startTime.toString(),
    endTime: endTime.toString(),
    nowTs: now.toString(),
    isActive,
    feeRecipientCount: feeRecipients.length,
  })
  if (!isActive) {
    const reason = startTime === 0n ? 'Public drop not configured' : startTime > now ? `Mint starts at ${new Date(Number(startTime) * 1000).toISOString()}` : `Mint ended at ${new Date(Number(endTime) * 1000).toISOString()}`
    throw new Error(`SeaDrop mint not active: ${reason}`)
  }
  const data = encodeFunctionData({
    abi: SEADROP_ABI,
    functionName: 'mintPublic',
    args: [nftContract, feeRecipient, '0x0000000000000000000000000000000000000000', quantity],
  })
  return [{ abi: SEADROP_ABI, functionName: 'mintPublic', args: [nftContract, feeRecipient, '0x0000000000000000000000000000000000000000', quantity], source: 'seadrop', toOverride: SEADROP_ADDRESS, valueOverride: totalValue, data }]
}

// _clientOverride: inject a mock viem publicClient for testing
// _supabase: optional supabase client for cache persistence (fire-and-forget)
export async function prepareMintTransaction(body, _clientOverride = null, _supabase = null) {
  const t0 = Date.now()
  const chain = normalizeChain(body.chain)
  const chainId = chainIdFor(chain)
  const contract = body.contractAddress || body.contract_address
  const walletAddress = body.walletAddress || body.wallet_address || body.account
  if (!contract || !isAddress(contract, { strict: false })) throw new Error('Contract address is required for Fast Mint.')
  if (!walletAddress || !isAddress(walletAddress, { strict: false })) throw new Error('Connect wallet before preparing this mint.')
  const executionProfile = body.executionProfile || body.execution_profile || null
  const rpcUrl = body.rpcUrl || body.rpc_url || null
  const rpcLabel = body.rpcLabel || body.rpc_label || rpcLabelForUrl(chain, rpcUrl || RPC_URLS[chain])
  const client = _clientOverride || publicClient(chain, rpcUrl, executionProfile)
  if (!client) throw new Error('Mint preparation needs RPC configured for this chain.')
  const hintedFunction = body.functionName || body.function_name || null

  const quantity = BigInt(Math.max(1, Number(body.quantity || body.max_mint || 1)))
  const value = parseEther(cleanPrice(body.mintPrice || body.mint_price || body.price)) * quantity
  const maxSpend = spendLimitWei(body)

  // Cache fast path: if we know which function worked before, skip bytecode+ABI+iteration
  const cachedExec = getCachedExecution(contract, chain)
  if (cachedExec) {
    // Prefer fallback candidate (reconstructs correct args for current quantity/wallet)
    const fastCandidate = fallbackCandidates(quantity, walletAddress).find(c => c.functionName === cachedExec.functionName)
    if (fastCandidate) {
      try {
        const data = encodeFunctionData({ abi: fastCandidate.abi, functionName: fastCandidate.functionName, args: fastCandidate.args })
        const [gasResult, gasPriceResult] = await Promise.allSettled([
          client.estimateGas({ account: walletAddress, to: contract, data, value }),
          maxSpend ? client.getGasPrice().catch(() => 0n) : Promise.resolve(0n),
        ])
        if (gasResult.status === 'fulfilled') {
          const gas = gasFromProfile(gasResult.value, executionProfile)
          const gasPrice = gasPriceResult.status === 'fulfilled' ? gasPriceResult.value : 0n
          if (maxSpend && (value + gas * gasPrice) > maxSpend) throw new Error('max_spend_exceeded')
          const latencyMs = Date.now() - t0
          console.log('[mint-benchmark] cache_hit', {
            duration_ms: latencyMs, chain, contract: contract.slice(0, 10),
            fn: fastCandidate.functionName, successCount: cachedExec.successCount,
          })
          recordLatency(contract, chain, latencyMs)
          const result = {
            to: contract, data, value: value.toString(), chainId, gas: gas.toString(),
            functionName: fastCandidate.functionName,
            argsSummary: fastCandidate.args.map(a => typeof a === 'bigint' ? a.toString() : String(a)),
            source: 'cache',
            cacheHit: true,
            latencyMs,
            executionState: executionProfile?.success_count ? 'Optimized' : 'Prepared',
            optimized: Boolean(executionProfile?.success_count),
            readinessBoost: readinessBoostFromProfile(executionProfile),
            rpcLabel,
            gasProfile: executionProfile ? {
              min: executionProfile.min_gas,
              avg: executionProfile.avg_gas,
              max: executionProfile.max_gas,
            } : null,
          }
          setCachedExecution(contract, chain, result, _supabase)
          return result
        }
        // Gas estimation failed for cached function — fall through to full path (cache may be stale)
        console.log('[mint-benchmark] cache_stale', { chain, contract: contract.slice(0, 10), fn: cachedExec.functionName })
      } catch (cacheErr) {
        if (String(cacheErr.message).includes('max_spend_exceeded')) throw cacheErr
        console.log('[mint-benchmark] cache_fast_path_fail', { chain, error: String(cacheErr.message || '').slice(0, 80) })
      }
    }
  }

  // Build ordered list of RPC clients to try: primary first, then fallbacks
  const primaryUrl = rpcUrl || RPC_URLS[chain]
  const fallbackUrls = _clientOverride ? [] : (RPC_FALLBACKS[chain] || []).filter(u => u !== primaryUrl)
  const rpcQueue = _clientOverride
    ? [{ activeClient: _clientOverride, url: 'injected' }]
    : [primaryUrl, ...fallbackUrls].filter(Boolean).map(url => ({ activeClient: publicClient(chain, url, executionProfile), url }))

  let lastError = null
  let seaDropError = null
  let attemptCount = 0

  for (const { activeClient: activeRpc, url: activeUrl } of rpcQueue) {
    if (!activeRpc) continue

    // Full path: bytecode existence check + verified ABI fetch (parallel, independent)
    const t1 = Date.now()
    let code, verifiedAbi
    try {
      ;[code, verifiedAbi] = await Promise.all([
        activeRpc.getBytecode({ address: contract }),
        fetchVerifiedAbi(contract, chain).catch(() => null),
      ])
    } catch (rpcErr) {
      if (isRpcFailure(rpcErr)) {
        console.log('[mint-benchmark] rpc_fail_fallback', { url: activeUrl.slice(0, 40), error: String(rpcErr.message || '').slice(0, 80) })
        lastError = rpcErr
        continue
      }
      throw rpcErr
    }

    console.log('[mint-benchmark] abi+bytecode', {
      duration_ms: Date.now() - t1,
      chain,
      contract: contract.slice(0, 10),
      rpc: activeUrl.replace(/^https?:\/\//, '').slice(0, 30),
      hasVerifiedAbi: Boolean(verifiedAbi),
      cacheSkipped: Boolean(cachedExec),
    })

    if (!code || code === '0x') throw new Error('No contract exists at this address on the selected chain.')

    // Protocol detection: SeaDrop contracts must be minted via the SeaDrop router
    let protocolCandidates = []
    if (isSeaDropContract(verifiedAbi)) {
      protocolCandidates = await buildSeaDropCandidates(contract, quantity, walletAddress, activeRpc).catch(e => {
        console.log('[mint-benchmark] seadrop_setup_fail', { error: String(e.message || '').slice(0, 80) })
        seaDropError = e
        return []
      })
    }

    // Deduplicate: skip fallback candidates whose function name is already covered by verified ABI
    const abiCandidates = candidatesFromAbi(verifiedAbi, quantity, walletAddress)
    const abiNames = new Set(abiCandidates.map(c => c.functionName))
    let allFallbacks = fallbackCandidates(quantity, walletAddress).filter(c => !abiNames.has(c.functionName))
    // If caller hinted a specific function name, promote it to the front of the fallback list
    if (hintedFunction) {
      const idx = allFallbacks.findIndex(c => c.functionName === hintedFunction)
      if (idx > 0) allFallbacks = [allFallbacks[idx], ...allFallbacks.filter((_, i) => i !== idx)]
    }
    // Protocol candidates (e.g. SeaDrop) go first — they're the exact correct call
    const candidates = [...protocolCandidates, ...abiCandidates, ...allFallbacks]
    console.log('[mint-benchmark] candidates', {
      chain,
      contract: contract.slice(0, 10),
      protocolCount: protocolCandidates.length,
      abiCount: abiCandidates.length,
      fallbackCount: allFallbacks.length,
      total: candidates.length,
      hint: hintedFunction || null,
      rpc: activeUrl.replace(/^https?:\/\//, '').slice(0, 30),
    })

    let rpcHadNetworkError = false
    for (const candidate of candidates) {
      attemptCount++
      try {
        // Protocol candidates (SeaDrop etc.) pre-compute data and override to/value
        const data = candidate.data || encodeFunctionData({
          abi: candidate.abi,
          functionName: candidate.functionName,
          args: candidate.args,
        })
        const txTo = candidate.toOverride || contract
        const txValue = candidate.valueOverride !== undefined ? candidate.valueOverride : value
        // Parallel: estimateGas + getGasPrice (getGasPrice only needed when spend limit set)
        const [gasResult, gasPriceResult] = await Promise.allSettled([
          activeRpc.estimateGas({ account: walletAddress, to: txTo, data, value: txValue }),
          maxSpend ? activeRpc.getGasPrice().catch(() => 0n) : Promise.resolve(0n),
        ])
        if (gasResult.status === 'rejected') {
          lastError = gasResult.reason
          if (isRpcFailure(gasResult.reason)) { rpcHadNetworkError = true; break }
          console.log('[mint-benchmark] candidate_fail', {
            chain,
            contract: contract.slice(0, 10),
            fn: candidate.functionName,
            source: candidate.source,
            error: String(gasResult.reason?.message || gasResult.reason || '').slice(0, 80),
          })
          continue
        }
        const gas = gasFromProfile(gasResult.value, executionProfile)
        const gasPrice = gasPriceResult.status === 'fulfilled' ? gasPriceResult.value : 0n
        if (maxSpend && (txValue + gas * gasPrice) > maxSpend) throw new Error('max_spend_exceeded')
        const latencyMs = Date.now() - t0
        console.log('[mint-benchmark] success', {
          duration_ms: latencyMs, chain, contract: contract.slice(0, 10),
          fn: candidate.functionName, source: candidate.source, gas: gas.toString(), attempts: attemptCount,
          rpc: activeUrl.replace(/^https?:\/\//, '').slice(0, 30),
        })
        recordLatency(contract, chain, latencyMs)
        const result = {
          to: txTo, data, value: txValue.toString(), chainId, gas: gas.toString(),
          functionName: candidate.functionName,
          argsSummary: candidate.args.map(arg => typeof arg === 'bigint' ? arg.toString() : String(arg)),
          source: candidate.source,
          cacheHit: false,
          latencyMs,
          executionState: executionProfile?.success_count ? 'Optimized' : 'Prepared',
          optimized: Boolean(executionProfile?.success_count),
          readinessBoost: readinessBoostFromProfile(executionProfile),
          rpcLabel: rpcLabelForUrl(chain, activeUrl),
          gasProfile: executionProfile ? {
            min: executionProfile.min_gas,
            avg: executionProfile.avg_gas,
            max: executionProfile.max_gas,
          } : null,
        }
        setCachedExecution(contract, chain, result, _supabase)
        return result
      } catch (error) {
        lastError = error
        if (isRpcFailure(error)) { rpcHadNetworkError = true; break }
      }
    }

    // If this RPC had a network error, try the next fallback; otherwise candidates are exhausted
    if (!rpcHadNetworkError) break
    console.log('[mint-benchmark] rpc_retry', { failedUrl: activeUrl.slice(0, 40), remaining: rpcQueue.length - rpcQueue.indexOf({ activeClient: activeRpc, url: activeUrl }) - 1 })
  }

  // SeaDrop contracts: if SeaDrop setup failed and all fallback candidates also failed,
  // the SeaDrop error is the authoritative reason (generic candidates can never work on these contracts)
  const definitiveError = seaDropError || lastError
  console.error('[mint-raw-error]', { raw: definitiveError?.message, stack: definitiveError?.stack?.slice(0, 300) })
  const rawReason = String(definitiveError?.shortMessage || definitiveError?.message || definitiveError || 'unknown')
  const userMessage = safeMessage(definitiveError)
  console.error('[mint-exec] all_candidates_failed', {
    stage: 'prepare',
    chain,
    contract: contract.slice(0, 10),
    attempts: attemptCount,
    real_error: rawReason.slice(0, 200),
    user_message: userMessage,
    duration_ms: Date.now() - t0,
  })
  const err = new Error(userMessage)
  err.rawReason = rawReason
  throw err
}

function intentPayload(user, body, status = 'draft') {
  const chain = normalizeChain(body.chain)
  const phase = normalizePhase(body.phase || body.mintPhase)
  const risk = Number(body.riskScore || 50)
  const mode = body.mode || recommendMode(phase, risk)
  return compactPayload({
    user_id: user.id,
    project_id: normalizeOptionalUuid(body.projectId || body.project_id),
    calendar_project_id: normalizeOptionalUuid(body.calendarProjectId || body.calendar_project_id),
    wl_project_id: normalizeOptionalUuid(body.wlProjectId || body.wl_project_id),
    project_name: body.name || body.projectName || 'Mint project',
    contract_address: normalizeOptionalText(body.contractAddress || body.contract_address),
    chain,
    chain_id: chainIdFor(chain),
    mint_url: body.mintUrl || body.mint_url || null,
    mint_phase: phase,
    execution_mode: mode,
    quantity: Number(body.quantity || 1),
    max_mint_price: body.maxMintPrice || body.max_mint_price || null,
    max_gas_fee: body.maxGasFee || body.max_gas_fee || null,
    max_total_spend: body.maxTotalSpend || body.max_total_spend || null,
    vault_wallet_id: normalizeOptionalUuid(body.vaultWalletId || body.vault_wallet_id),
    strike_enabled: body.strikeEnabled ?? body.strike_enabled,
    strike_status: body.strikeStatus || body.strike_status,
    strike_armed_at: body.strikeArmedAt || body.strike_armed_at,
    strike_execute_at: body.strikeExecuteAt || body.strike_execute_at,
    strike_error: body.strikeError || body.strike_error,
    status,
    last_state: status === 'prepared' ? EVENT_MESSAGES.prepared : EVENT_MESSAGES.preparing,
    updated_at: new Date().toISOString(),
  })
}

// Columns that may not exist in older DB schemas — stripped on schema errors
const OPTIONAL_INTENT_COLS = [
  'strike_status', 'strike_armed_at', 'strike_execute_at', 'strike_error',
  'vault_wallet_id', 'calendar_project_id', 'wl_project_id', 'chain_id',
  'mint_url', 'mint_phase', 'execution_mode', 'quantity',
  'max_mint_price', 'max_gas_fee', 'max_total_spend',
  'last_state', 'project_name',
]

async function insertOptional(supabase, table, row) {
  logSanitizedPayload('Strike sanitized payload before insert', { table, ...row })
  const { data, error } = await supabase.from(table).insert(row).select().single()
  if (!error) return data
  const msg = String(error.message || '').toLowerCase()
  if (!(msg.includes('schema') || msg.includes('column') || msg.includes('does not exist') || msg.includes('42703'))) throw error
  // Schema mismatch — strip optional columns and retry with core fields only
  console.warn('[mint-engine] insertOptional schema fallback', { table, error: error.message })
  const coreRow = Object.fromEntries(Object.entries(row).filter(([k]) => !OPTIONAL_INTENT_COLS.includes(k)))
  const { data: data2, error: error2 } = await supabase.from(table).insert(coreRow).select().single()
  if (!error2) return data2
  // Still failing — return localOnly so caller can surface the error cleanly
  console.error('[mint-engine] insertOptional fallback also failed', { table, error: error2.message, coreKeys: Object.keys(coreRow) })
  return { ...row, localOnly: true, _dbError: error2.message }
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
    ...compactPayload({
      ...payload,
      vault_wallet_id: normalizeOptionalUuid(payload.vault_wallet_id),
    }),
    strike_status: payload.strike_status || 'armed',
    status: payload.status || 'armed',
    updated_at: new Date().toISOString(),
  }
  logSanitizedPayload('Strike sanitized payload before update', fullPayload)
  let { data, error } = await supabase
    .from('mint_intents')
    .update(fullPayload)
    .eq('id', intentId)
    .eq('user_id', userId)
    .select()
    .single()
  if (!error) return data

  const message = String(error.message || '').toLowerCase()
  if (message.includes('schema cache') || message.includes('column') || message.includes('strike_status') || message.includes('strike_execute_at') || message.includes('vault_wallet_id') || message.includes('strike_armed_at') || message.includes('strike_error')) {
    const { strike_status, strike_execute_at, strike_armed_at, strike_error, vault_wallet_id, max_gas_fee, quantity, ...safePayload } = fullPayload
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
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return false
  return data?.[0] || null
}

export async function handleMintAction(req, res, action) {
  const allowed = new Set(['prepare', 'prewarm', 'readiness', 'enable-strike', 'stop', 'execute', 'confirm', 'status', 'strike-simulate', 'strike-replay', 'strike-rerun'])
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
      const optimizationProfile = await loadExecutionProfile(supabase, {
        chain: intent.chain,
        contractAddress: intent.contract_address,
      })
      return res.status(200).json({
        ok: true,
        intent,
        events: events || [],
        attempts,
        optimization: optimizationProfile ? optimizationTelemetry(optimizationProfile) : null,
      })
    }

    if (action === 'prewarm') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const chain = normalizeChain(body.chain)
      const contract = body.contractAddress || body.contract_address
      if (!contract) return res.status(200).json({ ok: true, cached: false, prewarm: getPrewarmStatus(null, null) })
      if (!SUPPORTED_EXECUTION_CHAINS.has(chain)) {
        return res.status(200).json({ ok: true, cached: false, prewarm: { ready: false, confidence: 0, functionName: null } })
      }
      // Return immediately if already cached — no need to re-run
      const existing = getPrewarmStatus(contract, chain)
      if (existing.ready) {
        return res.status(200).json({ ok: true, cached: true, prewarm: existing })
      }
      // Prewarm uses a placeholder wallet — just needs to detect the function
      const prewarmWallet = body.walletAddress || '0x0000000000000000000000000000000000000001'
      try {
        await prepareMintTransaction(
          { ...body, walletAddress: prewarmWallet, mintPrice: body.mintPrice || body.mint_price || '0' },
          null,
          supabase,
        )
      } catch {
        // Prewarm failure is non-fatal — return current (empty) status
      }
      return res.status(200).json({ ok: true, cached: false, prewarm: getPrewarmStatus(contract, chain) })
    }

    if (action === 'readiness') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body     = req.body || {}
      const chain    = normalizeChain(body.chain)
      const contract = normalizeOptionalText(body.contractAddress || body.contract_address)

      const readiness = computeReadiness(contract, chain)

      // Auto-trigger background prewarm when stale or function not yet detected
      if (contract && SUPPORTED_EXECUTION_CHAINS.has(chain) &&
          (readiness.staleCache || !readiness.checks.function_cached?.pass)) {
        prepareMintTransaction({
          chain,
          contractAddress: contract,
          walletAddress:   '0x0000000000000000000000000000000000000001',
          mintPrice:       body.mintPrice || '0',
          quantity:        Number(body.quantity) || 1,
        }, null, supabase).catch(() => null)
      }

      return res.status(200).json({ ok: true, readiness })
    }

    if (action === 'prepare') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const chain = normalizeChain(body.chain)
      if (!SUPPORTED_EXECUTION_CHAINS.has(chain)) return res.status(400).json(safeError('This chain is discovery-only for now.'))
      const contract = body.contractAddress || body.contract_address
      if (contract && !isAddress(contract)) return res.status(400).json(safeError('This contract address does not look right.'))
      const optimizationProfile = await loadExecutionProfile(supabase, { chain, contractAddress: contract })
      let preparedTransaction
      const prepareStartedAt = Date.now()
      try {
        preparedTransaction = await prepareMintTransaction({
          ...body,
          executionProfile: optimizationProfile,
        }, null, supabase)
      } catch (error) {
        const rawReason = error.rawReason || error.shortMessage || error.message || String(error)
        // error.rawReason means prepareMintTransaction already ran safeMessage — use error.message directly
        // to avoid double-classification (e.g. "Insufficient ETH" not matching safeMessage patterns again)
        const userMessage = error.rawReason ? error.message : safeMessage(error)
        console.error('[mint-exec] prepare_failed', {
          stage: 'prepare',
          chain,
          contract: contract?.slice?.(0, 12),
          real_error: rawReason.slice(0, 200),
          user_message: userMessage,
        })
        await recordExecutionOptimization(supabase, {
          chain,
          contractAddress: contract,
          status: 'failed',
          latencyMs: Date.now() - prepareStartedAt,
          errorMessage: userMessage,
        })
        return res.status(400).json({ ...safeError(userMessage), reason: rawReason.slice(0, 300) })
      }
      const prepareLatencyMs = Date.now() - prepareStartedAt
      const row = await insertOptional(supabase, 'mint_intents', intentPayload(user, body, 'prepared'))
      const intentId = row.id || `local-${Date.now()}`
      // Parallel DB inserts — order not load-bearing for display
      const eventWrites = [
        logEvent(supabase, intentId, user.id, 'preparing'),
        logEvent(supabase, intentId, user.id, 'phase'),
        logEvent(supabase, intentId, user.id, 'checking'),
        logEvent(supabase, intentId, user.id, 'prepared'),
      ]
      if (preparedTransaction.optimized) {
        eventWrites.push(logEvent(supabase, intentId, user.id, 'optimized', 'Optimized from previous execution history.', {
          readinessBoost: preparedTransaction.readinessBoost,
          gasProfile: preparedTransaction.gasProfile,
          bestRpc: optimizationProfile?.best_rpc || preparedTransaction.rpcLabel,
        }))
      }
      await Promise.all(eventWrites)
      await recordExecutionOptimization(supabase, {
        intent: { ...row, id: intentId, user_id: user.id },
        chain,
        contractAddress: contract,
        status: 'prepared',
        latencyMs: prepareLatencyMs,
        gasUsed: preparedTransaction.gas,
        functionName: preparedTransaction.functionName,
        functionSource: preparedTransaction.source,
        rpcLabel: preparedTransaction.rpcLabel,
      })
      return res.status(200).json({
        ok: true,
        intent: { ...row, id: intentId },
        mode: body.mode || row.execution_mode || 'safe',
        preparedTransaction,
        optimized: preparedTransaction.optimized,
        optimization: optimizationProfile ? optimizationTelemetry(optimizationProfile) : null,
        message: 'Mint prepared and simulated. Confirm in your wallet when ready.',
      })
    }

    if (action === 'enable-strike') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const { acknowledgeRisk, maxTotalSpend } = body
      let intentId = normalizeOptionalUuid(body.intentId || body.intent_id)
      const rawIntentId = body.intentId || body.intent_id
      if (hasRealValue(rawIntentId) && !intentId) return res.status(400).json(safeError('Mint session id is invalid.'))
      if (!AUTO_STRIKE_ENABLED || !ALPHA_VAULT_ENABLED) {
        return res.status(200).json({ ok: true, dryRun: true, error: 'Strike Mode is disabled by the global safety switch.' })
      }
      if (!acknowledgeRisk) return res.status(400).json(safeError('Confirm Strike Mode warnings before enabling.'))
      if (!maxTotalSpend) return res.status(400).json(safeError('Set a max spend limit before enabling Strike Mode.'))
      const vault = await loadVault(supabase, user.id)
      if (!vault) return res.status(400).json(safeError('Create Alpha Vault before enabling Strike Mode.'))
      const vaultWalletId = validateRequiredUuid(vault.id, 'Alpha Vault wallet id')
      const nowIso = new Date().toISOString()
      const requestedExecuteAt = body.strikeExecuteAt || body.strike_execute_at || body.mintDate || body.mint_date || nowIso
      const bodyContract = normalizeOptionalText(body.contractAddress || body.contract_address)
      if (!intentId) {
        const hasContract = Boolean(bodyContract)
        const created = await insertOptional(supabase, 'mint_intents', intentPayload(user, {
          ...body,
          mode: 'strike',
          maxTotalSpend,
          vaultWalletId,
          strikeEnabled: hasContract,
          strikeStatus: hasContract ? 'armed' : 'needs_contract',
          strikeArmedAt: hasContract ? nowIso : undefined,
          strikeExecuteAt: requestedExecuteAt,
          strikeError: hasContract ? null : 'Missing contract address',
          status: hasContract ? 'armed' : 'blocked',
        }, hasContract ? 'armed' : 'blocked'))
        intentId = created.id
        if (!intentId || created.localOnly) return res.status(500).json(safeError(`Could not create Strike mint session. DB: ${created._dbError || 'unknown error'}`))
      }
      const intent = await loadIntent(supabase, user.id, intentId)
      if (!intent) return res.status(404).json(safeError('Mint session not found.'))
      if (!intent.contract_address) {
        console.log('Strike blocked: missing contract address', intentId)
        const blocked = await updateStrikeIntent(supabase, intentId, user.id, {
          execution_mode: 'strike',
          max_total_spend: maxTotalSpend,
          max_gas_fee: body.maxGasFee || body.max_gas_fee || intent.max_gas_fee || null,
          quantity: Number(body.quantity || intent.quantity || 1),
          vault_wallet_id: vaultWalletId,
          strike_enabled: false,
          strike_status: 'needs_contract',
          status: 'blocked',
          strike_execute_at: requestedExecuteAt,
          strike_error: 'Missing contract address',
          last_state: 'Missing contract address',
        })
        await logEvent(supabase, intentId, user.id, 'failed', 'Strike Mode needs a contract address.', {
          vaultWalletId,
          strikeExecuteAt: requestedExecuteAt,
          reason: 'missing_contract',
        })
        return res.status(400).json({
          ...safeError('Add contract address before enabling Strike Mode.'),
          intent: blocked,
        })
      }
      if (!SUPPORTED_EXECUTION_CHAINS.has(intent.chain)) return res.status(400).json(safeError('This chain is not supported for Strike Mode yet.'))
      try {
        await prepareMintTransaction({ ...intent, walletAddress: vault.address || vault.wallet_address })
      } catch (error) {
        const msg = error.rawReason ? error.message : safeMessage(error)
        console.error('[mint-exec] strike_arm_failed', { stage: 'prepare', chain: intent.chain, contract: intent.contract_address?.slice(0, 12), real_error: (error.rawReason || error.message || '').slice(0, 200), user_message: msg })
        return res.status(400).json(safeError(msg))
      }
      const strikeExecuteAt = body.strikeExecuteAt || body.strike_execute_at || body.mintDate || intent.mint_date || nowIso
      const armed = await updateStrikeIntent(supabase, intentId, user.id, {
        execution_mode: 'strike',
        max_total_spend: maxTotalSpend,
        max_gas_fee: body.maxGasFee || body.max_gas_fee || intent.max_gas_fee || null,
        quantity: Number(body.quantity || intent.quantity || 1),
        vault_wallet_id: vaultWalletId,
        strike_enabled: true,
        strike_status: 'armed',
        status: 'armed',
        strike_armed_at: nowIso,
        strike_execute_at: strikeExecuteAt,
        strike_error: null,
        last_state: EVENT_MESSAGES.watching,
      })
      console.log('Strike intent armed', intentId)
      await logEvent(supabase, intentId, user.id, 'watching', 'Strike armed. Worker is watching.', {
        vaultWalletId,
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

    if (action === 'strike-simulate') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const body = req.body || {}
      const chain = normalizeChain(body.chain || 'eth')
      const contract = normalizeOptionalText(body.contractAddress || body.contract_address)
      const blockers = []
      const warnings = []

      // Vault readiness
      const vault = await loadVault(supabase, user.id)
      const walletReady = Boolean(vault)
      const walletAddress = vault?.address || vault?.wallet_address || null
      if (!walletReady) blockers.push('Alpha Vault not created — visit Settings to create one')

      // Contract + ABI validation
      let contractValid = false
      let functionName = null
      let estimatedGas = null
      if (!contract) {
        blockers.push('No contract address — add it in project settings')
      } else if (!isAddress(contract)) {
        blockers.push('Contract address format is invalid')
      } else if (!SUPPORTED_EXECUTION_CHAINS.has(chain)) {
        blockers.push(`Chain "${chain}" is not supported for Strike Mode`)
      } else {
        try {
          const prepared = await prepareMintTransaction({
            ...body,
            walletAddress: walletAddress || '0x0000000000000000000000000000000000000001',
            mintPrice: body.mintPrice || body.mint_price || '0',
          })
          contractValid = true
          functionName = prepared.functionName
          estimatedGas = prepared.gas ? String(prepared.gas) : null
        } catch (err) {
          const msg = err.rawReason ? err.message : safeMessage(err)
          // Insufficient funds is a wallet issue, not a contract issue
          if (msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('top up')) {
            warnings.push('Vault balance may not cover this mint — top up before arming')
            contractValid = true
          } else {
            blockers.push(msg)
          }
        }
      }

      // Chain RPC check
      const rpcUrl = RPC_URLS[chain] || null
      if (!rpcUrl) warnings.push(`No RPC URL configured for "${chain}" — add ${chain.toUpperCase()}_RPC_URL to env`)

      // Mint time
      const mintDate = body.mintDate || body.mint_date || null
      const projectStatus = body.projectStatus || body.project_status || null
      if (!mintDate && projectStatus === 'upcoming') {
        warnings.push('No confirmed mint time — Strike will fire when worker detects live state')
      }

      // Price
      const mintPrice = body.mintPrice || body.mint_price
      if (!mintPrice && mintPrice !== '0' && mintPrice !== 0) {
        warnings.push('Mint price unconfirmed — max spend limit will be used as a cap')
      }

      const liveExecutionEnabled = String(process.env.LIVE_EXECUTION_ENABLED || '').toLowerCase() === 'true'

      return res.status(200).json({
        ok: true,
        simulation: {
          wallet_ready: walletReady,
          wallet_address: walletAddress,
          contract_valid: contractValid,
          function_name: functionName,
          estimated_gas: estimatedGas,
          gas_strategy: 'balanced',
          rpc_available: Boolean(rpcUrl),
          rpc_url: rpcUrl,
          chain,
          execution_timing: mintDate || 'immediate',
          blockers,
          warnings,
          live_execution_enabled: liveExecutionEnabled,
        },
      })
    }

    if (action === 'strike-replay') {
      const intentId = normalizeOptionalUuid(req.query?.intentId || req.body?.intentId)
      if (!intentId) return res.status(400).json(safeError('intentId is required.'))
      const { data, error } = await supabase
        .from('mint_execution_events')
        .select('id, state, message, metadata, created_at')
        .eq('intent_id', intentId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(200)
      if (error) return res.status(500).json(safeError(error.message))
      return res.status(200).json({ ok: true, events: data ?? [] })
    }

    if (action === 'strike-rerun') {
      if (req.method !== 'POST') return res.status(405).json(safeError('Method not allowed.'))
      const { intentId } = req.body || {}
      const normalizedId = normalizeOptionalUuid(intentId)
      if (!normalizedId) return res.status(400).json(safeError('intentId is required.'))
      const { data: intent, error: loadErr } = await supabase
        .from('mint_intents')
        .select('id, status, strike_enabled')
        .eq('id', normalizedId)
        .eq('user_id', user.id)
        .single()
      if (loadErr || !intent) return res.status(404).json(safeError('Mint session not found.'))
      const RERUNNABLE = ['simulated_failure', 'simulated_success', 'failed']
      if (!RERUNNABLE.includes(intent.status)) {
        return res.status(400).json(safeError(`Intent status "${intent.status}" is not eligible for re-simulation.`))
      }
      const { error: updateErr } = await supabase
        .from('mint_intents')
        .update({
          status: 'armed',
          strike_enabled: true,
          simulation_status: null,
          simulation_error: null,
          last_state: 'Requeued for re-simulation',
          updated_at: new Date().toISOString(),
        })
        .eq('id', normalizedId)
        .eq('user_id', user.id)
      if (updateErr) return res.status(500).json(safeError(updateErr.message))
      await supabase.from('mint_execution_events').insert({
        intent_id: normalizedId,
        user_id: user.id,
        state: 'armed',
        message: 'Re-queued for simulation by user.',
        metadata: {},
      }).catch(() => null)
      return res.status(200).json({ ok: true, message: 'Simulation re-queued.' })
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
        preparedTransaction = await prepareMintTransaction({ ...intent, walletAddress: req.body?.walletAddress, mode }, null, supabase)
      } catch (error) {
        const msg = error.rawReason ? error.message : safeMessage(error)
        console.error('[mint-exec] execute_failed', { stage: 'prepare', chain: intent.chain, contract: intent.contract_address?.slice(0, 12), real_error: (error.rawReason || error.message || '').slice(0, 200), user_message: msg })
        return res.status(400).json(safeError(msg))
      }
      return res.status(200).json({
        ok: true,
        requiresWalletConfirmation: true,
        message: mode === 'fast' ? 'Fast Mint is ready. Confirm in your wallet.' : 'Safe Mint is ready. Confirm in your wallet.',
        transaction: preparedTransaction,
      })
    }
  } catch (error) {
    const msg = error.rawReason ? error.message : safeMessage(error)
    console.error('[mint-exec] engine_error', { action, real_error: (error.rawReason || error.message || String(error)).slice(0, 200), user_message: msg })
    return res.status(200).json(safeError(msg))
  }
}
