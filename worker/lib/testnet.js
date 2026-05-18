/**
 * Testnet chain configuration, mainnet rejection, and explorer link generation.
 * Only Sepolia (11155111) and Base Sepolia (84532) are in the execution allowlist.
 * Any attempt to execute on a mainnet chain ID throws immediately — this is the
 * hard outer gate before any viem client is created.
 */

// ─── Chain registry ───────────────────────────────────────────────────────────

export const TESTNET_CHAINS = {
  sepolia: {
    id: 11155111,
    name: 'Sepolia',
    network: 'sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.sepolia.org'] } },
    blockExplorers: { default: { name: 'Etherscan Sepolia', url: 'https://sepolia.etherscan.io' } },
    testnet: true,
  },
  'base-sepolia': {
    id: 84532,
    name: 'Base Sepolia',
    network: 'base-sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
    blockExplorers: { default: { name: 'Basescan Sepolia', url: 'https://sepolia.basescan.org' } },
    testnet: true,
  },
}

/** Mainnet chain IDs — any of these are hard-blocked in testnet execution. */
export const MAINNET_CHAIN_IDS = new Set([1, 8453, 56, 33139, 137, 42161, 10, 43114, 250])

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Map any chain string to a testnet key, routing mainnet aliases to their
 * testnet equivalents. Returns null for unrecognized chains.
 *
 * @param {string} chain
 * @returns {'sepolia'|'base-sepolia'|null}
 */
export function normalizeTestnetChain(chain) {
  const s = String(chain || '').toLowerCase().trim()
  if (s === 'sepolia' || s === '11155111')                          return 'sepolia'
  if (s === 'base-sepolia' || s === 'basesepolia' || s === '84532') return 'base-sepolia'
  // Route mainnet aliases to testnet equivalents
  if (s === 'eth' || s === 'ethereum' || s === 'mainnet' || s === '1') return 'sepolia'
  if (s === 'base' || s === '8453')                                  return 'base-sepolia'
  return null
}

// ─── Safety guards ────────────────────────────────────────────────────────────

/**
 * Return true if the numeric chain ID belongs to a known mainnet.
 * @param {number|string} chainId
 */
export function isMainnetChainId(chainId) {
  return MAINNET_CHAIN_IDS.has(Number(chainId))
}

/**
 * Throw if the given chain ID is a known mainnet.
 * Called as the final safety check before viem client construction.
 *
 * @param {number|string} chainId
 * @throws {Error}
 */
export function assertNotMainnet(chainId) {
  if (isMainnetChainId(chainId)) {
    throw new Error(
      `Testnet execution rejected: chain ID ${chainId} is a mainnet chain — refusing to broadcast`,
    )
  }
}

/**
 * Throw if testnetKey is not in the testnet allowlist, or maps to a mainnet
 * chain ID (should never happen given TESTNET_CHAINS, but verified defensively).
 *
 * @param {string|null} testnetKey
 * @throws {Error}
 */
export function assertTestnetOnly(testnetKey) {
  if (!testnetKey) {
    throw new Error('Testnet execution rejected: chain is null or unrecognized')
  }
  const chain = TESTNET_CHAINS[testnetKey]
  if (!chain) {
    throw new Error(
      `Testnet execution rejected: '${testnetKey}' is not in the testnet execution allowlist`,
    )
  }
  assertNotMainnet(chain.id)
}

// ─── Chain lookup ─────────────────────────────────────────────────────────────

/**
 * Return the viem-compatible chain descriptor for a testnet key.
 * @param {string} testnetKey
 * @returns {object}
 */
export function getTestnetChain(testnetKey) {
  const chain = TESTNET_CHAINS[testnetKey]
  if (!chain) throw new Error(`Unknown testnet chain: ${testnetKey}`)
  return chain
}

// ─── RPC URLs ─────────────────────────────────────────────────────────────────

const TESTNET_RPC_ENV = {
  sepolia:        ['SEPOLIA_RPC_URL', 'SEPOLIA_RPC_URL_FALLBACK_1'],
  'base-sepolia': ['BASE_SEPOLIA_RPC_URL', 'BASE_SEPOLIA_RPC_URL_FALLBACK_1'],
}

const TESTNET_RPC_FALLBACKS = {
  sepolia:        ['https://rpc.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc2.sepolia.org'],
  'base-sepolia': ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
}

/**
 * Return ordered RPC URLs for a testnet chain. Env-configured URLs come first.
 * @param {string} testnetKey
 * @returns {string[]}
 */
export function getTestnetRpcUrls(testnetKey) {
  const envKeys  = TESTNET_RPC_ENV[testnetKey] ?? []
  const envUrls  = envKeys.map(k => process.env[k]).filter(Boolean)
  const fallbacks = TESTNET_RPC_FALLBACKS[testnetKey] ?? []
  return [...new Set([...envUrls, ...fallbacks])]
}

// ─── Explorer links ───────────────────────────────────────────────────────────

/**
 * Return a block explorer URL for a transaction hash.
 * @param {string} testnetKey
 * @param {string} txHash
 * @returns {string|null}
 */
export function getExplorerTxLink(testnetKey, txHash) {
  const chain = TESTNET_CHAINS[testnetKey]
  if (!chain || !txHash) return null
  return `${chain.blockExplorers.default.url}/tx/${txHash}`
}

/**
 * Return a block explorer URL for a contract/wallet address.
 * @param {string} testnetKey
 * @param {string} address
 * @returns {string|null}
 */
export function getExplorerAddressLink(testnetKey, address) {
  const chain = TESTNET_CHAINS[testnetKey]
  if (!chain || !address) return null
  return `${chain.blockExplorers.default.url}/address/${address}`
}

// ─── Known testnet contracts ──────────────────────────────────────────────────

/**
 * Sample NFT contracts deployed on testnets for Strike Engine integration tests.
 * These are reference/stub addresses — point to actual testnet-deployed contracts.
 */
export const TESTNET_SAMPLE_CONTRACTS = {
  sepolia: {
    erc721_public_mint: '0x0000000000000000000000000000000000000000', // deploy and replace
    erc721_allowlist:   '0x0000000000000000000000000000000000000000',
  },
  'base-sepolia': {
    erc721_public_mint: '0x0000000000000000000000000000000000000000',
    erc721_allowlist:   '0x0000000000000000000000000000000000000000',
  },
}
