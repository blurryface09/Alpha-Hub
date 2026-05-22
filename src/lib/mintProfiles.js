/**
 * Execution profile classification for Mint Capture Mode.
 * Identifies protocol, function, and proof shape from captured transaction data.
 */

// Known protocol routers by lowercase address
export const KNOWN_ROUTERS = {
  '0x00005ea00ac477b1030ce78506496e8c2de24bf5': { protocol: 'seadrop',   name: 'SeaDrop v1',           chain: 'eth' },
  '0x26bbea7803dcac346d5f5f135b57cf2c752a02be': { protocol: 'manifold',  name: 'Manifold ERC721' },
  '0x80fad33cadb5b5f0adfe660b14ca58d27a56b6b6': { protocol: 'manifold',  name: 'Manifold Lazy Mint' },
  '0x04e2516a2c207e84a1839755675dfd8ef6302f0a': { protocol: 'zora',      name: 'Zora ERC1155 Minter',  chain: 'eth' },
  '0x777777c338d93e2c7adf08d102d45ca7cc4ed021': { protocol: 'zora',      name: 'Zora ERC721',          chain: 'eth' },
  '0x777777e8850d8d6d98de2b5f64fae401f96eff31': { protocol: 'zora',      name: 'Zora ERC1155 Creator', chain: 'eth' },
  '0x8087039152c472fa74f47398628ff002994056ea': { protocol: 'highlight', name: 'Highlight Minter' },
  '0x84aa935f20c65d29d2cc5b766d67e7a858c2a60c': { protocol: 'highlight', name: 'Highlight ERC721' },
  '0x4bb71be9cf3ecf3c4c93ef0adb7162505d39a294': { protocol: 'thirdweb',  name: 'Thirdweb Drop' },
}

// Known 4-byte function selectors
export const KNOWN_SELECTORS = {
  '0x6871ee40': { fn: 'mintPublic',                                  protocol: 'seadrop'   },
  '0x54ab11e9': { fn: 'mintAllowList',                               protocol: 'seadrop',  proofRequired: true },
  '0xa0712d68': { fn: 'mint(uint256)'                                                       },
  '0x1249c58b': { fn: 'mint()'                                                              },
  '0x40d097c3': { fn: 'safeMint(address)'                                                   },
  '0xd0def521': { fn: 'mintNFT(address,uint256)'                                            },
  '0x6a627842': { fn: 'mint(address)'                                                       },
  '0x731133e9': { fn: 'mint(address,uint256,uint256,bytes)',          protocol: 'erc1155'   },
  '0xf7d975e4': { fn: 'mintWithQuantity(uint256)'                                           },
  '0x84bb1e42': { fn: 'claim(address,uint256,address,uint256,...)',   protocol: 'thirdweb', proofRequired: true },
  '0xde0e9a3e': { fn: 'mintWithRewards(address,uint256,uint256,...)', protocol: 'zora'     },
  '0x7ff3eb60': { fn: 'purchasePresale(uint32,uint256,bytes32[])',                          proofRequired: true },
  '0x4b5d5e6d': { fn: 'purchase(uint256)'                                                   },
  '0x02329a29': { fn: 'adminMint(address,uint32)'                                           },
}

export const PROTOCOL_LABELS = {
  seadrop:   'SeaDrop',
  manifold:  'Manifold',
  zora:      'Zora',
  highlight: 'Highlight',
  thirdweb:  'Thirdweb',
  erc1155:   'ERC-1155',
  custom:    'Custom',
}

/**
 * Extract the 4-byte function selector from calldata hex.
 */
export function extractSelector(calldata) {
  if (!calldata || calldata.length < 10) return null
  return calldata.slice(0, 10).toLowerCase()
}

/**
 * Classify a captured tx into { protocol, name, selector, proofRequired }.
 */
export function classifyProtocol(toAddress, calldata) {
  const to = (toAddress || '').toLowerCase()
  const sel = extractSelector(calldata)
  const routerMatch = KNOWN_ROUTERS[to]
  const selMatch = sel ? KNOWN_SELECTORS[sel] : null

  if (routerMatch) {
    return {
      protocol: routerMatch.protocol,
      name: routerMatch.name,
      selector: sel,
      proofRequired: selMatch?.proofRequired ?? false,
      isKnownRouter: true,
    }
  }

  if (selMatch) {
    return {
      protocol: selMatch.protocol || 'custom',
      name: selMatch.fn,
      selector: sel,
      proofRequired: selMatch.proofRequired ?? false,
      isKnownRouter: false,
    }
  }

  return {
    protocol: 'custom',
    name: sel ? `selector:${sel}` : 'Unknown',
    selector: sel,
    proofRequired: false,
    isKnownRouter: false,
  }
}

/**
 * Heuristic to detect proof shape from calldata size and selector.
 * Returns: 'merkle_proof' | 'signature' | 'complex' | 'none'
 */
export function detectProofShape(calldata) {
  if (!calldata || calldata.length < 10) return 'none'
  const sel = extractSelector(calldata)
  if (sel && KNOWN_SELECTORS[sel]?.proofRequired) return 'merkle_proof'
  // Calldata with large dynamic arrays strongly suggests proof
  const byteLen = (calldata.length - 2) / 2
  if (byteLen > 400) return 'complex'
  if (byteLen > 200) return 'signature'
  return 'none'
}

/**
 * Build a profile object from a captured transaction ready to POST to /api/capture/save.
 */
export function buildProfileFromCapture(tx, project) {
  const { to, data, value, gas } = tx || {}
  const sel = extractSelector(data)
  const proto = classifyProtocol(to, data)
  const proofShape = detectProofShape(data)

  return {
    contractAddress: (project?.contract_address || '').toLowerCase(),
    chain: project?.chain || 'eth',
    projectId: project?.id || null,
    toAddress: (to || '').toLowerCase(),
    calldata: (data || '').toLowerCase(),
    selector: sel,
    valueWei: String(value || '0'),
    mintFunction: proto.name || null,
    protocol: proto.protocol || 'custom',
    routerAddress: proto.isKnownRouter ? (to || '').toLowerCase() : null,
    proofRequired: proofShape !== 'none',
    proofShape,
    multicall: false,
    source: 'capture',
    tx: { to, data, value, gas },
  }
}

/**
 * Build a profile from a successful prepareMintTransaction result (auto-learn).
 * Called server-side in mint-engine — keeps the same shape as capture profiles.
 */
export function buildProfileFromPrepared({ functionName, preparedTransaction, chain, contractAddress, walletAddress }) {
  const tx = preparedTransaction || {}
  const sel = extractSelector(tx.data)
  const proto = classifyProtocol(tx.to, tx.data)

  return {
    contract_address: (contractAddress || '').toLowerCase(),
    chain: chain || 'eth',
    to_address: (tx.to || contractAddress || '').toLowerCase(),
    calldata: (tx.data || '').toLowerCase() || null,
    selector: sel,
    value_wei: String(tx.value || '0'),
    gas_limit: tx.gas ? Number(tx.gas) : null,
    mint_function: functionName || proto.name || null,
    protocol: proto.protocol || 'custom',
    router_address: proto.isKnownRouter ? (tx.to || '').toLowerCase() : null,
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
