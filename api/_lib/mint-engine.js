import { createPublicClient, encodeFunctionData, http, isAddress, keccak256, encodeAbiParameters, encodePacked, decodeAbiParameters, parseAbi, parseEther } from 'viem'
import { createServiceClient, requireUser } from './auth.js'
import { rateLimit, sendRateLimit } from './redis.js'
import { chainIdFor, normalizeChain, normalizePhase, recommendMode } from './project-intelligence.js'
import {
  getCachedAbi, setCachedAbi,
  getCachedExecution, setCachedExecution, loadCachedExecution,
  getCachedProbeResult, setCachedProbeResult,
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
  'function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)',
  'function getAllowListMerkleRoot(address nftContract) view returns (bytes32)',
  'function getSignedMintValidationParams(address nftContract) view returns ((uint80 minMintPrice, uint24 maxMaxTotalMintableByWallet, uint40 minStartTime, uint40 maxEndTime, uint40 maxMaxTokenSupplyForStage, uint16 minFeeBps, uint16 maxFeeBps))',
])
// keccak256("AllowListUpdated(address,bytes32,bytes32,string[],string)")
const SEADROP_ALLOWLIST_UPDATED_TOPIC = '0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5'
// IPFS public gateways tried in order
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
]
// MintParams ABI type (used for leaf computation and mintAllowList encoding)
const MINT_PARAMS_ABI_TYPE = { type: 'tuple', components: [
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' },
]}
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
  if (msg.includes('seadrop proof unavailable') || msg.includes('proof could not be fetched') || msg.includes('all_strategies_exhausted') || msg.includes('allowlist too large')) return 'Wallet may be eligible, but the allowlist proof is only available through the official mint page.'
  if (msg.includes('seadrop wallet not eligible') || msg.includes('not on the allowlist') || msg.includes('wallet not eligible') || msg.includes('not in the on-chain allowlist')) return 'This wallet is not on the allowlist for this mint.'
  if (msg.includes('seadrop signed mint') || msg.includes('signed mint: proof requires')) return 'Proof requires OpenSea session. Use official mint.'
  if (msg.includes('seadrop allowlist phase') || msg.includes('merkle proof required')) return 'Allowlist phase active — wallet may be eligible. Check the official mint page for your proof.'
  if (msg.includes('seadrop allowlist only') || (msg.includes('seadrop') && msg.includes('allowlist'))) return 'This mint is currently allowlist-only. Public mint is not active for this wallet.'
  if (msg.includes('seadrop mint not active') || msg.includes('public drop not configured') || msg.includes('not currently active')) return 'This mint is not currently active — the public drop is not open yet. Check the official mint page.'
  if (msg.includes('sale not active') || msg.includes('sale is not active') || msg.includes('not started') || msg.includes('not open') || msg.includes('mint closed') || msg.includes('mint has not') || msg.includes('minting is not') || msg.includes('paused')) return 'Mint is not open yet or has ended. Check the official mint page for the correct time.'
  if (msg.includes('allowlist') || msg.includes('not whitelisted') || msg.includes('not eligible') || msg.includes('merkle') || msg.includes('not in whitelist')) return 'Mint rejected — your wallet is not on the allowlist for this phase.'
  if (msg.includes('already minted') || msg.includes('max per wallet') || msg.includes('max mint') || msg.includes('limit reached') || msg.includes('max tokens') || msg.includes('token limit')) return 'Max mints reached — this wallet has hit the limit for this mint.'
  if (msg.includes('max supply') || msg.includes('sold out') || msg.includes('exceeds max') || msg.includes('supply exceeded') || msg.includes('supply exhausted')) return 'Sold out — this mint has reached maximum supply.'
  if (msg.includes('wrong eth') || msg.includes('msg.value') || msg.includes('wrong value') || msg.includes('incorrect value') || msg.includes('invalid price') || msg.includes('price mismatch')) return 'Wrong mint price — check the price on the official mint page.'
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

// Classify a gas-estimation failure into a discrete execution state.
// 'live' = contract is accepting the call (wallet just has no ETH).
function classifyExecutionStatus(error, { seaDropError = null } = {}) {
  if (seaDropError && !error) return 'router_required'
  const msg = String(error?.shortMessage || error?.message || error || '').toLowerCase()
  if (msg.includes('insufficient funds') || msg.includes('exceeds the balance') || msg.includes('exceeds balance') || msg.includes('total cost')) return 'live'
  // Payment mismatch: contract is live but value sent is wrong — treat as live so the probe
  // cache is not poisoned when prewarm runs with mintPrice=0
  if (msg.includes('wrong eth') || msg.includes('incorrect payment') || msg.includes('incorrectpayment') || msg.includes('wrong value') || msg.includes('incorrect value') || msg.includes('msg.value') || msg.includes('wrong payment')) return 'live'
  // Allowlist-specific states — check before generic seadrop/allowlist catches
  if (msg.includes('seadrop proof unavailable') || msg.includes('proof could not be fetched')) return 'proof_unavailable'
  if (msg.includes('seadrop wallet not eligible') || msg.includes('not on the allowlist') || msg.includes('wallet not eligible') || msg.includes('not in the on-chain allowlist')) return 'wallet_not_eligible'
  if (msg.includes('seadrop signed mint') || msg.includes('signed mint: proof requires')) return 'signed_mint_only'
  if (msg.includes('seadrop allowlist phase') || msg.includes('merkle proof required')) return 'allowlist_ready'
  if (msg.includes('seadrop allowlist only') || (msg.includes('seadrop') && msg.includes('allowlist'))) return 'allowlist_only'
  if (msg.includes('seadrop') || msg.includes('router_required')) return 'router_required'
  if (msg.includes('paused') || msg.includes('ownable') || msg.includes('caller is not the owner')) return 'paused'
  if (
    msg.includes('sale not active') || msg.includes('sale is not active') || msg.includes('not started') ||
    msg.includes('not open') || msg.includes('mint closed') || msg.includes('mint has not') ||
    msg.includes('minting is not') || msg.includes('seadrop mint not active') ||
    msg.includes('public drop not configured') || msg.includes('not currently active')
  ) return 'not_started'
  if (msg.includes('allowlist') || msg.includes('not whitelisted') || msg.includes('not eligible') || msg.includes('merkle') || msg.includes('not in whitelist') || msg.includes('invalid proof') || msg.includes('proof verification')) return 'allowlist_only'
  if (msg.includes('max supply') || msg.includes('sold out') || msg.includes('exceeds max') || msg.includes('supply exceeded') || msg.includes('supply exhausted') || msg.includes('max per wallet') || msg.includes('already minted') || msg.includes('max mint') || msg.includes('limit reached')) return 'sold_out'
  if (msg.includes('function') || msg.includes('selector') || msg.includes('unknown mint') || msg.includes('no standard mint')) return 'wrong_function'
  if (msg.includes('rpc') || msg.includes('fetch failed') || msg.includes('network error') || msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('timeout')) return 'error'
  // Unknown revert: contract rejected the call for an unrecognized reason.
  // Use 'not_started' rather than 'paused' — the most common cause is the mint not being open yet.
  if (msg.includes('revert') || msg.includes('execution reverted')) return 'not_started'
  return 'unsupported_execution'
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
  // Array and fixed-array types (e.g. bytes32[], uint256[5]) can't be safely inferred.
  // bytes32[] is almost always a merkle proof; uint256[]/address[] are batch params.
  if (t.includes('[')) return null
  if (/^uint/.test(t) || /^int/.test(t)) return 0n
  if (t === 'address') return '0x0000000000000000000000000000000000000000'
  if (t === 'bool') return false
  if (t === 'string') return ''
  if (/^bytes/.test(t)) return '0x'  // bytes, bytes32, bytes calldata, etc.
  return null  // tuple or unknown — can't safely guess
}

export function argsForInputs(inputs = [], quantity, walletAddress) {
  if (!inputs.length) return []
  // Build args type-by-type, substituting quantity for the first uint and walletAddress for address.
  // Array types (bytes32[], uint256[]) are rejected up front — can't safely infer proof or batch data.
  let usedQuantity = false
  const args = []
  for (const input of inputs) {
    const t = String(input?.type || '')
    // Array/fixed-array types can't be safely inferred (merkle proofs, batch token IDs, etc.)
    if (t.includes('[')) return null
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

// Normalise an API-returned MintParams object into viem-compatible BigInt fields.
function parseMintParams(raw) {
  return {
    mintPrice:                  BigInt(raw.mintPrice               ?? raw.mint_price                ?? 0),
    maxTotalMintableByWallet:   BigInt(raw.maxTotalMintableByWallet ?? raw.max_total_mintable_by_wallet ?? 1),
    startTime:                  BigInt(raw.startTime               ?? raw.start_time                ?? 0),
    endTime:                    BigInt(raw.endTime                 ?? raw.end_time                  ?? 0),
    dropStageIndex:             BigInt(raw.dropStageIndex          ?? raw.drop_stage_index          ?? 1),
    maxTokenSupplyForStage:     BigInt(raw.maxTokenSupplyForStage  ?? raw.max_token_supply_for_stage ?? 0),
    feeBps:                     BigInt(raw.feeBps                  ?? raw.fee_bps                   ?? 500),
    restrictFeeRecipients:      Boolean(raw.restrictFeeRecipients  ?? raw.restrict_fee_recipients),
  }
}

// ─── Merkle proof helpers ─────────────────────────────────────────────────────

function sortedPairHash(a, b) {
  return a <= b
    ? keccak256(encodePacked(['bytes32', 'bytes32'], [a, b]))
    : keccak256(encodePacked(['bytes32', 'bytes32'], [b, a]))
}

// SeaDrop leaf: keccak256(abi.encode(address, MintParams))
function seaDropLeaf(walletAddress, mp) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, MINT_PARAMS_ABI_TYPE],
    [walletAddress, [
      BigInt(mp.mintPrice ?? mp.mint_price ?? 0),
      BigInt(mp.maxTotalMintableByWallet ?? mp.max_total_mintable_by_wallet ?? 1),
      BigInt(mp.startTime ?? mp.start_time ?? 0),
      BigInt(mp.endTime ?? mp.end_time ?? 0),
      BigInt(mp.dropStageIndex ?? mp.drop_stage_index ?? 1),
      BigInt(mp.maxTokenSupplyForStage ?? mp.max_token_supply_for_stage ?? 0),
      BigInt(mp.feeBps ?? mp.fee_bps ?? 500),
      Boolean(mp.restrictFeeRecipients ?? mp.restrict_fee_recipients),
    ]]
  ))
}

// Build sorted-pair merkle tree from an ordered list of leaves.
// Returns { layers, root } where layers[0] = leaves, layers[last] = [root].
function buildMerkleTree(leaves) {
  if (!leaves.length) return { layers: [], root: '0x' + '0'.repeat(64) }
  if (leaves.length === 1) return { layers: [leaves], root: leaves[0] }
  const layers = [leaves]
  let cur = [...leaves]
  while (cur.length > 1) {
    const next = []
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i]
      const b = i + 1 < cur.length ? cur[i + 1] : a  // duplicate last if odd
      next.push(sortedPairHash(a, b))
    }
    layers.push(next)
    cur = next
  }
  return { layers, root: cur[0] }
}

// Return the merkle proof path for a leaf at `leafIndex` in a pre-built tree.
function getProofForIndex(layers, leafIndex) {
  const proof = []
  let idx = leafIndex
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i]
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1
    // If sibling index is out of bounds, the leaf was duplicated — sibling = same leaf
    proof.push(siblingIdx < layer.length ? layer[siblingIdx] : layer[idx])
    idx = Math.floor(idx / 2)
  }
  return proof
}

// ─── On-chain allowlist fetching ──────────────────────────────────────────────

// Fetch the allowListURI for a contract from Etherscan's AllowListUpdated event logs.
async function fetchAllowListUri(nftContract, chain) {
  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.VITE_ETHERSCAN_API_KEY || ''
  if (!apiKey) {
    console.log('[allowlist-proof] etherscan_key_missing', { contract: nftContract.slice(0, 10) })
    return null
  }
  const chainId = chainIdFor(chain)
  // Topic1: nftContract address padded to 32 bytes (indexed parameter encoding)
  const topic1 = '0x' + '0'.repeat(24) + nftContract.slice(2).toLowerCase()
  const url = new URL('https://api.etherscan.io/v2/api')
  url.searchParams.set('chainid', String(chainId))
  url.searchParams.set('module', 'logs')
  url.searchParams.set('action', 'getLogs')
  url.searchParams.set('address', SEADROP_ADDRESS)
  url.searchParams.set('topic0', SEADROP_ALLOWLIST_UPDATED_TOPIC)
  url.searchParams.set('topic1', topic1)
  url.searchParams.set('topic0_1_opr', 'and')
  url.searchParams.set('page', '1')
  url.searchParams.set('offset', '5')
  url.searchParams.set('sort', 'desc')
  url.searchParams.set('apikey', apiKey)
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    if (data.status !== '1' || !data.result?.length) {
      console.log('[allowlist-proof] no_event_found', { contract: nftContract.slice(0, 10), status: data.status, msg: data.message })
      return null
    }
    const log = data.result[0]
    const [publicKeyURIs, allowListURI] = decodeAbiParameters(
      [{ type: 'string[]' }, { type: 'string' }],
      log.data
    )
    console.log('[allowlist-proof] uri_from_event', {
      contract: nftContract.slice(0, 10), chain,
      allowListURI: allowListURI?.slice(0, 60),
      isSignedMint: publicKeyURIs?.length > 0,
      blockNumber: parseInt(log.blockNumber, 16),
    })
    return { allowListURI, publicKeyURIs: publicKeyURIs || [] }
  } catch (e) {
    console.log('[allowlist-proof] etherscan_error', { err: String(e.message || '').slice(0, 60) })
    return null
  }
}

// Fetch the allowlist JSON from a URI (IPFS or HTTP). Returns parsed entries or null.
async function fetchAllowListData(uri) {
  if (!uri || uri.length < 4) return null
  // Convert ipfs:// to HTTP gateway
  const urls = uri.startsWith('ipfs://')
    ? IPFS_GATEWAYS.map(gw => gw + uri.slice(7))
    : [uri]
  for (const url of urls) {
    try {
      // HEAD first to check size
      try {
        const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
        const size = parseInt(head.headers.get('content-length') || '0')
        if (size > 15_000_000) {
          console.log('[allowlist-proof] allowlist_too_large', { url: url.slice(0, 60), size })
          return { tooBig: true }
        }
      } catch {}
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) continue
      const text = await res.text()
      if (text.length > 15_000_000) return { tooBig: true }
      const json = JSON.parse(text)
      // Support multiple JSON shapes
      const entries = Array.isArray(json) ? json
        : Array.isArray(json.allowList) ? json.allowList
        : Array.isArray(json.entries)   ? json.entries
        : Array.isArray(json.data)      ? json.data
        : null
      if (!entries) continue
      console.log('[allowlist-proof] entries_fetched', { url: url.slice(0, 60), count: entries.length })
      return { entries, merkleRoot: json.merkleRoot || null }
    } catch (e) {
      console.log('[allowlist-proof] fetch_uri_fail', { url: url.slice(0, 60), err: String(e.message || '').slice(0, 50) })
    }
  }
  return null
}

// Find wallet in entries and return proof + mintParams. Returns null if wallet not found.
function computeProofForWallet(entries, walletAddress) {
  const wallet = walletAddress.toLowerCase()
  const idx = entries.findIndex(e => (e.address || '').toLowerCase() === wallet)
  if (idx === -1) return null
  const entry = entries[idx]
  const mintParams = entry.mintParams || entry.mint_params || entry
  // Fast path: pre-computed proof is included in the allowlist data
  if (Array.isArray(entry.proof) && entry.proof.length > 0) {
    return { proof: entry.proof, mintParams, source: 'precomputed_in_uri', walletIdx: idx }
  }
  // Compute proof from full tree
  const leaves = entries.map(e => seaDropLeaf(e.address, e.mintParams || e.mint_params || e))
  const { layers, root } = buildMerkleTree(leaves)
  const proof = getProofForIndex(layers, idx)
  return { proof, mintParams, source: 'computed_from_uri', merkleRoot: root, walletIdx: idx }
}

// ─── Allowlist proof fetching ─────────────────────────────────────────────────

// Fetch SeaDrop allowlist proof for a wallet. Returns { proof, mintParams, feeRecipient, source } or null.
// Throws (not returns null) for explicit wallet_not_eligible or signed_mint cases.
async function fetchSeaDropAllowlistProof(nftContract, walletAddress, chainId) {
  const chain = { 1: 'eth', 8453: 'base', 56: 'bnb', 11155111: 'sepolia', 84532: 'base-sepolia' }[chainId] || 'eth'
  const walletLower = walletAddress.toLowerCase()

  // ── Strategy 1: On-chain AllowListURI via Etherscan AllowListUpdated events ──
  // This is the primary path — no OpenSea auth required, works from on-chain data.
  try {
    const eventData = await fetchAllowListUri(nftContract, chain)
    if (eventData) {
      const { allowListURI, publicKeyURIs } = eventData
      // publicKeyURIs present + no usable allowListURI → signed mint phase, can't fetch sig
      if (publicKeyURIs.length > 0 && (!allowListURI || allowListURI.trim().length < 4)) {
        console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'signed_mint', proof_found: false, proof_source: 'signed_mint_key', failure_reason: 'signed_mint_requires_project_signature' })
        throw new Error('SeaDrop signed mint: proof requires a signature from the project — use the official mint page')
      }
      if (allowListURI?.trim().length > 3) {
        const listData = await fetchAllowListData(allowListURI)
        if (listData?.tooBig) {
          console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'allowlist', proof_found: false, proof_source: 'uri_too_large', failure_reason: 'allowlist_too_large_for_local_compute' })
          // Fall through to API strategies for large lists
        } else if (listData?.entries) {
          const proofResult = computeProofForWallet(listData.entries, walletAddress)
          if (!proofResult) {
            console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'allowlist', proof_found: false, proof_source: allowListURI?.slice(0,40), failure_reason: 'wallet_not_in_allowlist', entries_checked: listData.entries.length })
            throw new Error('SeaDrop wallet not eligible: wallet is not in the on-chain allowlist')
          }
          console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'allowlist', proof_found: true, proof_source: proofResult.source, function: 'mintAllowList', proof_len: proofResult.proof.length, failure_reason: null })
          return { proof: proofResult.proof, mintParams: proofResult.mintParams, feeRecipient: null, source: proofResult.source }
        }
      }
    }
  } catch (e) {
    if (e.message.includes('wallet not eligible') || e.message.includes('not in the on-chain') || e.message.includes('signed mint')) throw e
    console.log('[allowlist-proof] uri_strategy_error', { err: String(e.message || '').slice(0, 80) })
  }

  // ── Strategy 2: OpenSea API ──
  // OpenSea's proof endpoints require auth (401) as of investigation. Kept for forward-compatibility.
  const CHAIN_SLUGS = { 1: 'ethereum', 8453: 'base', 56: 'bsc', 11155111: 'sepolia', 84532: 'base_sepolia' }
  const chainSlug = CHAIN_SLUGS[chainId] || 'ethereum'
  const osEndpoints = [
    `https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${nftContract}/seadrop/allowlist-proof?wallet_address=${walletAddress}`,
    `https://api.opensea.io/api/v2/seadrop/allowlist-proof?chain_id=${chainId}&nft_address=${nftContract}&wallet_address=${walletAddress}`,
  ]
  for (const url of osEndpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
      if (res.status === 401 || res.status === 403) {
        console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'allowlist', proof_found: false, proof_source: 'opensea_api', failure_reason: `opensea_auth_required_${res.status}` })
        continue
      }
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      if (!data) continue
      const proof = data.proof ?? data.merkle_proof ?? data.allowlist_proof ?? data.merkleProof
      const mintParamsRaw = data.mint_params ?? data.mintParams ?? data.drop_stage ?? data.dropStage
      if (Array.isArray(proof) && proof.length > 0 && mintParamsRaw) {
        console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'allowlist', proof_found: true, proof_source: 'opensea_api', function: 'mintAllowList', failure_reason: null })
        return { proof, mintParams: mintParamsRaw, feeRecipient: data.fee_recipient ?? null, source: 'opensea_api' }
      }
    } catch {}
  }

  console.log('[allowlist-proof]', { wallet: walletLower.slice(0,10), contract: nftContract.slice(0,10), phase: 'allowlist', proof_found: false, proof_source: null, failure_reason: 'all_strategies_exhausted' })
  return null
}

async function buildSeaDropCandidates(nftContract, chain, quantity, walletAddress, client) {
  const chainId = chainIdFor(chain)
  const [feeResult, dropResult, merkleResult] = await Promise.allSettled([
    client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getAllowedFeeRecipients', args: [nftContract] }),
    client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getPublicDrop', args: [nftContract] }),
    client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getAllowListMerkleRoot', args: [nftContract] }),
  ])
  const feeRecipients = feeResult.status === 'fulfilled' ? feeResult.value : []
  const feeRecipient = feeRecipients[0] || SEADROP_FEE_RECIPIENT_FALLBACK
  const drop = dropResult.status === 'fulfilled' ? dropResult.value : null
  const merkleRoot = merkleResult.status === 'fulfilled' ? merkleResult.value : null
  // viem returns positional array for multi-output functions (decodeFunctionResult lines 22-23)
  // getPublicDrop: [0]=mintPrice, [1]=startTime, [2]=endTime, [3]=maxTotalMintableByWallet, [4]=feeBps, [5]=restrictFeeRecipients
  const mintPrice = drop ? BigInt(drop[0] || 0n) : 0n
  const totalValue = mintPrice * quantity
  const now = BigInt(Math.floor(Date.now() / 1000))
  const startTime = drop ? BigInt(drop[1] || 0n) : 0n
  const endTime = drop ? BigInt(drop[2] || 0n) : 0n
  const isActive = startTime > 0n && startTime <= now && (endTime === 0n || endTime > now)
  const hasAllowlist = Boolean(merkleRoot && merkleRoot !== '0x' + '0'.repeat(64))
  console.log('[mint-benchmark] seadrop_detected', {
    nftContract: nftContract.slice(0, 10),
    feeRecipient: feeRecipient.slice(0, 10),
    mintPrice: mintPrice.toString(),
    startTime: startTime.toString(),
    endTime: endTime.toString(),
    nowTs: now.toString(),
    isActive,
    hasAllowlist,
    feeRecipientCount: feeRecipients.length,
  })

  if (isActive) {
    // Public drop is live — use mintPublic
    const data = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [nftContract, feeRecipient, '0x0000000000000000000000000000000000000000', quantity],
    })
    return [{ abi: SEADROP_ABI, functionName: 'mintPublic', args: [nftContract, feeRecipient, '0x0000000000000000000000000000000000000000', quantity], source: 'seadrop', toOverride: SEADROP_ADDRESS, valueOverride: totalValue, data }]
  }

  // Not active — check allowlist
  if (startTime === 0n && feeRecipients.length > 0) {
    // No public drop configured. Check if an allowlist phase is active.
    if (hasAllowlist) {
      // Allowlist merkle tree exists — try to fetch proof for this wallet
      const isStubWallet = walletAddress === '0x0000000000000000000000000000000000000001' || walletAddress === '0x0000000000000000000000000000000000000000'
      if (isStubWallet) {
        // Can't fetch proof for stub wallet (used in simulations) — signal allowlist phase clearly
        throw new Error('SeaDrop allowlist phase: merkle proof required — wallet is eligible if on allowlist')
      }

      let proofData = null
      try {
        proofData = await fetchSeaDropAllowlistProof(nftContract, walletAddress, chainId)
      } catch (proofErr) {
        // Re-throw definitive failures (wallet not eligible, signed mint)
        const pMsg = String(proofErr.message || '')
        if (pMsg.includes('wallet not eligible') || pMsg.includes('not on the allowlist') || pMsg.includes('not in the on-chain')) {
          throw new Error('SeaDrop wallet not eligible: wallet is not on the allowlist for this mint')
        }
        if (pMsg.includes('signed mint')) throw proofErr  // propagate signed mint message as-is
        console.log('[allowlist-proof]', { wallet: walletAddress.slice(0, 10), contract: nftContract.slice(0, 10), phase: 'allowlist', proof_found: false, failure_reason: 'probe_error', function: 'mintAllowList' })
      }

      if (proofData) {
        const { proof, mintParams: mintParamsRaw, feeRecipient: proofFeeRecipient, source } = proofData
        const effectiveFeeRecipient = proofFeeRecipient || feeRecipient
        const mintParams = parseMintParams(mintParamsRaw)
        const allowlistValue = mintParams.mintPrice * quantity
        const data = encodeFunctionData({
          abi: SEADROP_ABI,
          functionName: 'mintAllowList',
          args: [nftContract, effectiveFeeRecipient, '0x0000000000000000000000000000000000000000', quantity, mintParams, proof],
        })
        console.log('[allowlist-proof]', {
          wallet: walletAddress.slice(0, 10), contract: nftContract.slice(0, 10),
          phase: 'allowlist', proof_found: true, function: 'mintAllowList',
          source, proofLen: proof.length, failure_reason: null,
        })
        return [{
          abi: SEADROP_ABI,
          functionName: 'mintAllowList',
          args: [nftContract, effectiveFeeRecipient, '0x0000000000000000000000000000000000000000', quantity, mintParams, proof],
          source: `seadrop_allowlist:${source}`,
          toOverride: SEADROP_ADDRESS,
          valueOverride: allowlistValue,
          data,
        }]
      }

      // Proof fetch returned null — allowlist exists but proof API unavailable
      console.log('[allowlist-proof]', { wallet: walletAddress.slice(0, 10), contract: nftContract.slice(0, 10), phase: 'allowlist', proof_found: false, failure_reason: 'api_unavailable', function: 'mintAllowList' })
      throw new Error('SeaDrop proof unavailable: wallet may be eligible but the allowlist proof could not be fetched — use the official mint page')
    }

    // No merkle root — check if this is a signed mint phase
    try {
      const signedParams = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getSignedMintValidationParams', args: [nftContract] })
      const hasSignedMint = signedParams && (signedParams.maxEndTime > 0n || signedParams.maxMaxTotalMintableByWallet > 0n)
      if (hasSignedMint) {
        console.log('[allowlist-proof]', { wallet: walletAddress.slice(0,10), contract: nftContract.slice(0,10), phase: 'signed_mint', proof_found: false, proof_source: null, failure_reason: 'signed_mint_no_public_api' })
        throw new Error('SeaDrop signed mint: proof requires a signature from the project — use the official mint page')
      }
    } catch (e) {
      if (e.message.includes('signed mint')) throw e
    }
    throw new Error('SeaDrop allowlist only: no public drop configured, allowlist or signed mint required')
  }

  const reason = startTime > now
    ? `Mint starts at ${new Date(Number(startTime) * 1000).toISOString()}`
    : `Mint ended at ${new Date(Number(endTime) * 1000).toISOString()}`
  throw new Error(`SeaDrop mint not active: ${reason}`)
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

  // Warm in-memory cache from Supabase on cold start (no-op if already warm or no client)
  if (_supabase) await loadCachedExecution(contract, chain, _supabase)

  // Cache fast path: if we know which function worked before, skip bytecode+ABI+iteration.
  // Skip for SeaDrop: the fast path always uses to=contract and common_signature ABI which
  // are both wrong for SeaDrop — gas estimation would fail and fall through anyway.
  const cachedExec = getCachedExecution(contract, chain)
  if (cachedExec && cachedExec.source !== 'seadrop') {
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
  let hadVerifiedAbi = false
  const triedFunctions = []

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
    if (verifiedAbi) hadVerifiedAbi = true

    // Protocol detection: SeaDrop contracts must be minted via the SeaDrop router
    let protocolCandidates = []
    if (isSeaDropContract(verifiedAbi)) {
      // Verified ABI confirms SeaDrop — set seaDropError on failure so definitiveError is correct
      protocolCandidates = await buildSeaDropCandidates(contract, chain, quantity, walletAddress, activeRpc).catch(e => {
        console.log('[mint-benchmark] seadrop_setup_fail', { error: String(e.message || '').slice(0, 80) })
        seaDropError = e
        return []
      })
    } else if (!verifiedAbi) {
      // No verified ABI — blindly probe SeaDrop to catch unverified SeaDrop contracts.
      // Do NOT set seaDropError on failure: we don't know if it's SeaDrop, so keep definitiveError neutral.
      try {
        const blindCandidates = await buildSeaDropCandidates(contract, chain, quantity, walletAddress, activeRpc)
        if (blindCandidates.length > 0) {
          protocolCandidates = blindCandidates
          console.log('[mint-benchmark] seadrop_blind_detected', { contract: contract.slice(0, 10), chain })
        }
      } catch {
        console.log('[mint-benchmark] seadrop_blind_miss', { contract: contract.slice(0, 10), chain })
      }
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
      triedFunctions.push(candidate.functionName)
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
        console.log('[mint-path-trace]', {
          contract,
          chain,
          abi_source: hadVerifiedAbi ? 'etherscan_verified' : 'none',
          candidates_tried: attemptCount,
          all_fns_tried: [...new Set(triedFunctions)],
          selected_fn: candidate.functionName,
          selected_args: candidate.args.map(a => typeof a === 'bigint' ? a.toString() : String(a)),
          msg_value: txValue.toString(),
          calldata: data?.slice(0, 42) || null,
          router_target: txTo !== contract ? txTo : 'direct',
          gas_estimate: gas.toString(),
          source: candidate.source,
          outcome: 'success',
        })
        setCachedExecution(contract, chain, result, _supabase)
        setCachedProbeResult(contract, chain, { execution_status: 'live', function_tried: candidate.functionName })
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
  const probeStatus = classifyExecutionStatus(definitiveError, { seaDropError })
  console.error('[mint-exec] all_candidates_failed', {
    stage: 'prepare',
    chain,
    contract: contract.slice(0, 10),
    attempts: attemptCount,
    real_error: rawReason.slice(0, 200),
    user_message: userMessage,
    execution_status: probeStatus,
    duration_ms: Date.now() - t0,
  })
  setCachedProbeResult(contract, chain, { execution_status: probeStatus, revert_reason: rawReason.slice(0, 200), function_tried: null })
  const _isSeaDrop = Boolean(seaDropError)
  console.log('[restriction-detect]', {
    contract: contract.slice(0, 10),
    chain,
    phase: _isSeaDrop ? (probeStatus === 'allowlist_only' ? 'seadrop_allowlist' : 'seadrop_public') : 'unknown',
    restriction_type: probeStatus,
    proof_available: false,
    execution_supported: !['allowlist_only', 'signed_mint_only', 'proof_required', 'router_required', 'captcha_required', 'unsupported_execution'].includes(probeStatus),
  })
  console.log('[mint-path-trace]', {
    contract,
    chain,
    abi_source: hadVerifiedAbi ? 'etherscan_verified' : 'none',
    candidates_tried: attemptCount,
    all_fns_tried: [...new Set(triedFunctions)],
    selected_fn: null,
    msg_value: value.toString(),
    router_target: seaDropError ? SEADROP_ADDRESS : 'direct',
    gas_estimate: null,
    raw_revert: rawReason.slice(0, 200),
    classified_reason: userMessage,
    execution_status: probeStatus,
    outcome: 'failed',
  })
  const err = new Error(userMessage)
  err.rawReason = rawReason
  throw err
}

// Validate execution path WITHOUT requiring gas estimation to succeed.
// Used by strike-simulate to pre-arm before public mint opens.
// Returns { prepared_execution_status, functionName, seaDropDrop, details }
// Statuses: public_live | waiting_public_drop | allowlist_only | ready | unsupported_contract
async function probeCapability(contract, chain, quantity, walletAddress, clientOverride = null) {
  const client = clientOverride || publicClient(chain, null, null)
  if (!client) return { prepared_execution_status: 'unsupported_contract', details: 'No RPC for chain' }

  // Bytecode check
  let code
  try { code = await client.getBytecode({ address: contract }) } catch { /* network — treat as unknown */ }
  if (!code || code === '0x') return { prepared_execution_status: 'unsupported_contract', details: 'No contract bytecode at address' }

  // Fetch verified ABI in parallel with SeaDrop probe
  const verifiedAbi = await fetchVerifiedAbi(contract, chain).catch(() => null)

  const qty = BigInt(Math.max(1, Number(quantity || 1)))

  // SeaDrop path: verified ABI confirms, or blind probe for unverified contracts
  const isConfirmedSeaDrop = isSeaDropContract(verifiedAbi)
  if (isConfirmedSeaDrop || !verifiedAbi) {
    try {
      const [feeResult, dropResult] = await Promise.allSettled([
        client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getAllowedFeeRecipients', args: [contract] }),
        client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: 'getPublicDrop', args: [contract] }),
      ])
      const feeRecipients = feeResult.status === 'fulfilled' ? feeResult.value : []
      const drop = dropResult.status === 'fulfilled' ? dropResult.value : null

      if (isConfirmedSeaDrop || feeRecipients.length > 0 || drop) {
        // This IS a SeaDrop contract — classify its state
        // viem positional array: [0]=mintPrice, [1]=startTime, [2]=endTime
        const startTime = drop ? BigInt(drop[1] || 0n) : 0n
        const endTime = drop ? BigInt(drop[2] || 0n) : 0n
        const mintPrice = drop ? BigInt(drop[0] || 0n) : 0n
        const now = BigInt(Math.floor(Date.now() / 1000))
        const isActive = startTime > 0n && startTime <= now && (endTime === 0n || endTime > now)

        console.log('[capability-check]', {
          contract: contract.slice(0, 10), chain,
          seadrop: true, confirmed: isConfirmedSeaDrop,
          startTime: startTime.toString(), endTime: endTime.toString(),
          feeRecipientCount: feeRecipients.length, isActive,
        })

        if (isActive) {
          return { prepared_execution_status: 'public_live', functionName: 'mintPublic', seaDropDrop: drop, details: 'SeaDrop public drop active' }
        }
        if (startTime === 0n && feeRecipients.length > 0) {
          return { prepared_execution_status: 'allowlist_only', details: 'SeaDrop: no public drop, allowlist/signed phase only' }
        }
        if (startTime > now) {
          return {
            prepared_execution_status: 'waiting_public_drop',
            functionName: 'mintPublic',
            seaDropDrop: drop,
            details: `SeaDrop public drop opens at ${new Date(Number(startTime) * 1000).toISOString()}`,
            startTime: Number(startTime),
            mintPrice: mintPrice.toString(),
          }
        }
        // endTime in the past → ended; if confirmed SeaDrop treat as unsupported
        if (isConfirmedSeaDrop) {
          return { prepared_execution_status: 'unsupported_contract', details: 'SeaDrop public drop has ended' }
        }
        // Unverified: blind probe returned no useful state, fall through to standard detection
      }
    } catch (e) {
      console.log('[capability-check] seadrop_probe_error', { contract: contract.slice(0, 10), err: String(e.message || '').slice(0, 80) })
      if (isConfirmedSeaDrop) return { prepared_execution_status: 'unsupported_contract', details: 'SeaDrop state read failed' }
    }
  }

  // Standard ERC721/ERC1155: can we build valid calldata?
  const candidates = verifiedAbi
    ? candidatesFromAbi(verifiedAbi, qty, walletAddress)
    : fallbackCandidates(qty, walletAddress)

  if (candidates.length > 0) {
    // If we can construct calldata without gas estimation, execution path is ready
    try {
      const c = candidates[0]
      const data = c.data || encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args })
      console.log('[capability-check]', {
        contract: contract.slice(0, 10), chain, seadrop: false,
        abi_source: verifiedAbi ? 'verified' : 'fallback',
        fn: c.functionName, calldata_prefix: data?.slice(0, 10),
      })
      return { prepared_execution_status: 'ready', functionName: c.functionName, details: `Calldata constructible via ${c.source}` }
    } catch {
      // encodeFunctionData failure — bad ABI candidate
    }
  }

  return { prepared_execution_status: 'unsupported_contract', details: 'No constructible execution path found' }
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
  'project_id',
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

// ── Capture profile helpers ───────────────────────────────────────────────────

const CAPTURE_TABLE = 'mint_capture_profiles'

function isCaptureSchemaError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (String(err?.code || '') === '42P01') || msg.includes(CAPTURE_TABLE) || msg.includes('schema cache') || msg.includes('does not exist')
}

async function loadCaptureProfile(supabase, { contractAddress, chain }) {
  if (!supabase || !contractAddress) return null
  const addr = contractAddress.toLowerCase()
  try {
    const { data, error } = await supabase
      .from(CAPTURE_TABLE)
      .select('id, mint_function, router_address, selector, protocol, proof_required, proof_shape, gas_avg, gas_min, gas_max, sample_count, verified')
      .eq('contract_address', addr)
      .eq('chain', chain || 'eth')
      .order('sample_count', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) { if (isCaptureSchemaError(error)) return null; throw error }
    return data
  } catch { return null }
}

function _buildAutoLearnProfile({ functionName, tx, chain, contractAddress }) {
  const sel = tx.data?.slice(0, 10)?.toLowerCase() || null
  const toAddr = (tx.to || contractAddress || '').toLowerCase()
  return {
    contract_address: contractAddress.toLowerCase(),
    chain: chain || 'eth',
    to_address: toAddr,
    calldata: (tx.data || '').toLowerCase() || null,
    selector: sel,
    value_wei: String(tx.value || '0'),
    gas_limit: tx.gas ? Number(tx.gas) : null,
    mint_function: functionName || null,
    protocol: 'custom',
    router_address: null,
    proof_required: false,
    proof_shape: 'none',
    multicall: false,
    source: 'auto_learn',
    sample_count: 1,
    verified: false,
    shared: false,
    captured_at: new Date().toISOString(),
  }
}

async function autoLearnCaptureProfile(supabase, userId, { chain, contractAddress, preparedTransaction, functionName }) {
  if (!supabase || !contractAddress) return
  const tx = preparedTransaction?.preparedTransaction || {}
  if (!tx.data || !tx.to) return
  const profile = _buildAutoLearnProfile({ functionName, tx, chain, contractAddress })
  const addr = contractAddress.toLowerCase()

  try {
    const { data: existing } = await supabase
      .from(CAPTURE_TABLE)
      .select('id, sample_count, gas_avg')
      .eq('contract_address', addr)
      .eq('chain', chain || 'eth')
      .eq('source', 'auto_learn')
      .maybeSingle()

    const gas = profile.gas_limit
    if (existing) {
      const n = (existing.sample_count || 0) + 1
      const gAvg = existing.gas_avg && gas ? Math.round(((existing.gas_avg * (n - 1)) + gas) / n) : gas || existing.gas_avg
      await supabase.from(CAPTURE_TABLE).update({ sample_count: n, gas_avg: gAvg, mint_function: profile.mint_function, updated_at: new Date().toISOString() }).eq('id', existing.id)
    } else {
      await supabase.from(CAPTURE_TABLE).insert({ ...profile, user_id: userId })
    }
    console.log('[capture-learn]', { contract: addr.slice(0, 12), fn: functionName, chain, source: 'auto_learn' })
  } catch (err) {
    if (!isCaptureSchemaError(err)) console.warn('[capture-learn] save_error', err.message?.slice(0, 80))
  }
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

      // Warm the in-memory cache from DB before scoring — the Railway worker writes
      // successful execution configs to mint_contract_cache but Vercel's in-memory
      // Map is cold on every serverless invocation.  loadCachedExecution is a no-op
      // when the cache is already warm (in-memory hit skips the DB round-trip).
      if (contract) await loadCachedExecution(contract, chain, supabase).catch(() => null)
      const readiness = computeReadiness(contract, chain)

      // Derive execution_status from probe cache (15-min TTL), with exec cache as fallback.
      const probeResult = contract ? getCachedProbeResult(contract, chain) : null
      const executionStatus = probeResult?.execution_status || 'not_probed'

      console.log('[mint-live-probe]', {
        contract: contract?.slice(0, 10) || null,
        chain,
        execution_status: executionStatus,
        revert_reason:    probeResult?.revert_reason  || null,
        function_tried:   probeResult?.function_tried || null,
        probe_age_s:      probeResult ? Math.round((Date.now() - probeResult.at) / 1000) : null,
      })

      // Auto-trigger background prewarm when stale or function not yet detected.
      // Only fire when we don't already have a definitive positive probe result — avoids
      // running value=0 gas estimation against contracts that are live with a price, which
      // would overwrite a valid 'live' probe status with a spurious failure.
      const positiveProbe = probeResult && ['live', 'not_started', 'allowlist_ready', 'captured_ready'].includes(probeResult.execution_status)
      if (contract && SUPPORTED_EXECUTION_CHAINS.has(chain) &&
          !positiveProbe &&
          (readiness.staleCache || !readiness.checks.function_cached?.pass)) {
        prepareMintTransaction({
          chain,
          contractAddress: contract,
          walletAddress:   '0x0000000000000000000000000000000000000001',
          mintPrice:       body.mintPrice || '0',
          quantity:        Number(body.quantity) || 1,
        }, null, supabase).catch(() => null)
      }

      return res.status(200).json({ ok: true, readiness: { ...readiness, execution_status: executionStatus } })
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
      // Phase 5 — auto-learn: save execution profile fire-and-forget
      // Skip stub prewarm wallets so we only learn from real mint paths
      const isRealWallet = body.walletAddress && body.walletAddress !== '0x0000000000000000000000000000000000000001'
      if (isRealWallet && preparedTransaction?.preparedTransaction?.data && contract) {
        autoLearnCaptureProfile(supabase, user.id, {
          chain, contractAddress: contract, userId: user.id,
          preparedTransaction, functionName: preparedTransaction.functionName,
        }).catch(() => {})
      }
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

      // Phase 3 — pre-load capture profile: skip ABI guessing if we have a learned profile
      const captureProfile = await loadCaptureProfile(supabase, { contractAddress: intent.contract_address, chain: intent.chain })
      if (captureProfile) {
        console.log('[strike-prep]', {
          stage: 'capture_profile_match',
          contract: intent.contract_address?.slice(0, 12),
          chain: intent.chain,
          protocol: captureProfile.protocol,
          fn: captureProfile.mint_function,
          samples: captureProfile.sample_count,
        })
      }

      try {
        await prepareMintTransaction({
          ...intent,
          walletAddress: vault.address || vault.wallet_address,
          // Pass learned function name to skip ABI iteration
          functionName: intent.functionName || captureProfile?.mint_function || null,
        }, null, supabase)
        console.log('[strike-prep]', { stage: 'arm_prepare_ok', contract: intent.contract_address?.slice(0, 12), chain: intent.chain, usedProfile: Boolean(captureProfile) })
      } catch (error) {
        const msg = error.rawReason ? error.message : safeMessage(error)
        // If we have a capture profile, allow arm immediately — we know the execution path
        if (captureProfile && !['signed_mint_only', 'captcha_required', 'router_required', 'unsupported_contract'].includes(classifyExecutionStatus(error.message))) {
          console.log('[strike-prep]', { stage: 'arm_via_capture_profile', contract: intent.contract_address?.slice(0, 12), protocol: captureProfile.protocol, fn: captureProfile.mint_function })
          // Profile-based arm: skip probeCapability, proceed to arm
        } else {
          // Check if we can still pre-arm via capability probe (mint not open yet but path is valid)
          try {
            const armRpc = publicClient(intent.chain, RPC_URLS[intent.chain], null)
            const armQty = BigInt(Math.max(1, Number(intent.quantity || 1)))
            const armWallet = vault.address || vault.wallet_address || '0x0000000000000000000000000000000000000001'
            const capability = await probeCapability(intent.contract_address, intent.chain, armQty, armWallet, armRpc)
            console.log('[strike-prep]', {
              stage: 'arm_capability_probe', contract: intent.contract_address?.slice(0, 12), chain: intent.chain,
              prepared_status: capability.prepared_execution_status,
            })
            const armableStatuses = new Set(['waiting_public_drop', 'ready', 'public_live'])
            if (!armableStatuses.has(capability.prepared_execution_status)) {
              console.error('[mint-exec] strike_arm_failed', { stage: 'prepare', chain: intent.chain, contract: intent.contract_address?.slice(0, 12), real_error: (error.rawReason || error.message || '').slice(0, 200), user_message: msg, capability: capability.prepared_execution_status })
              return res.status(400).json(safeError(msg))
            }
            // Allow arm — execution path is valid but mint is not live yet
          } catch (probeErr) {
            console.error('[mint-exec] strike_arm_failed', { stage: 'prepare', chain: intent.chain, contract: intent.contract_address?.slice(0, 12), real_error: (error.rawReason || error.message || '').slice(0, 200), user_message: msg })
            return res.status(400).json(safeError(msg))
          }
        }
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
      let executionStatus = 'not_probed'
      let preparedExecutionStatus = 'not_probed'
      if (!contract) {
        blockers.push('No contract address — add it in project settings')
      } else if (!isAddress(contract)) {
        blockers.push('Contract address format is invalid')
      } else if (!SUPPORTED_EXECUTION_CHAINS.has(chain)) {
        blockers.push(`Chain "${chain}" is not supported for Strike Mode`)
      } else {
        let preparedExecStatus = 'not_probed'
        try {
          const prepared = await prepareMintTransaction({
            ...body,
            walletAddress: walletAddress || '0x0000000000000000000000000000000000000001',
            mintPrice: body.mintPrice || body.mint_price || '0',
          }, null, supabase)
          contractValid = true
          functionName = prepared.functionName
          estimatedGas = prepared.gas ? String(prepared.gas) : null
          executionStatus = 'live'
          preparedExecStatus = 'public_live'
          console.log('[strike-prep]', { stage: 'prepare_ok', contract: contract?.slice(0, 10), chain, fn: functionName })
        } catch (err) {
          const msg = err.rawReason ? err.message : safeMessage(err)
          // Insufficient funds = wallet issue, contract IS open
          if (msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('top up')) {
            warnings.push('Vault balance may not cover this mint — top up before arming')
            contractValid = true
            executionStatus = 'live'
            preparedExecStatus = 'public_live'
            console.log('[strike-prep]', { stage: 'live_low_balance', contract: contract?.slice(0, 10), chain })
          } else {
            // Gas estimation failed — classify the error first
            executionStatus = classifyExecutionStatus(err)

            // Allowlist-specific states: don't need probeCapability, classification is definitive
            if (executionStatus === 'proof_unavailable') {
              // Allowlist configured, vault wallet may be eligible but proof API unavailable
              contractValid = true
              preparedExecStatus = 'proof_unavailable'
              blockers.push(msg)
              console.log('[strike-prep]', { stage: 'proof_unavailable', contract: contract?.slice(0, 10), chain })
            } else if (executionStatus === 'wallet_not_eligible') {
              preparedExecStatus = 'wallet_not_eligible'
              blockers.push(msg)
              console.log('[strike-prep]', { stage: 'wallet_not_eligible', contract: contract?.slice(0, 10), chain })
            } else if (executionStatus === 'allowlist_ready') {
              // Allowlist phase, stub wallet was used in sim — real wallet may have a proof
              contractValid = true
              preparedExecStatus = 'allowlist_ready'
              warnings.push('Allowlist phase active — vault wallet eligibility unknown. Run Strike Sim with vault wallet connected.')
              console.log('[strike-prep]', { stage: 'allowlist_ready', contract: contract?.slice(0, 10), chain })
            } else {
              // Structural unknown — probe capability without requiring live execution
              const rpcClient = publicClient(chain, RPC_URLS[chain], null)
              const qty = BigInt(Math.max(1, Number(body.quantity || body.max_mint || 1)))
              const stubWallet = walletAddress || '0x0000000000000000000000000000000000000001'
              try {
                const capability = await probeCapability(contract, chain, qty, stubWallet, rpcClient)
                preparedExecStatus = capability.prepared_execution_status
                functionName = capability.functionName || null
                console.log('[strike-prep]', {
                  stage: 'capability_probe', contract: contract?.slice(0, 10), chain,
                  prepared_status: preparedExecStatus, fn: functionName, details: capability.details,
                })
                if (preparedExecStatus === 'waiting_public_drop') {
                  contractValid = true
                  executionStatus = 'not_started'
                  warnings.push(`Execution path ready — waiting for public mint to open${capability.startTime ? ` (${new Date(capability.startTime * 1000).toLocaleString()})` : ''}`)
                } else if (preparedExecStatus === 'ready') {
                  contractValid = true
                  warnings.push('Contract execution path ready — mint may not be open yet. Strike will fire when live.')
                } else if (preparedExecStatus === 'public_live') {
                  contractValid = true
                  executionStatus = 'live'
                } else if (preparedExecStatus === 'allowlist_only') {
                  blockers.push('This mint is allowlist-only — no public drop is configured. Alpha Hub cannot execute this mint.')
                } else {
                  blockers.push(msg)
                }
              } catch (probeErr) {
                console.log('[strike-prep]', { stage: 'capability_probe_error', err: String(probeErr.message || '').slice(0, 80) })
                preparedExecStatus = 'not_probed'
                blockers.push(msg)
              }
            }
          }
        }
        preparedExecutionStatus = preparedExecStatus
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

      // Phase 3 — promote to captured_ready if a capture profile exists for this contract
      let captureProfileSim = null
      if (contract && !blockers.some(b => b.includes('contract address'))) {
        captureProfileSim = await loadCaptureProfile(supabase, { contractAddress: contract, chain })
        if (captureProfileSim && !['signed_mint_only', 'captcha_required', 'router_required', 'unsupported_contract'].includes(preparedExecutionStatus)) {
          preparedExecutionStatus = 'captured_ready'
          contractValid = true
          if (!functionName && captureProfileSim.mint_function) functionName = captureProfileSim.mint_function
          console.log('[strike-prep]', { stage: 'sim_capture_profile', contract: contract?.slice(0, 10), protocol: captureProfileSim.protocol, fn: captureProfileSim.mint_function })
        }
      }

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
          execution_status: executionStatus,
          prepared_execution_status: preparedExecutionStatus,
          capture_protocol: captureProfileSim?.protocol || null,
          capture_sample_count: captureProfileSim?.sample_count || null,
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
