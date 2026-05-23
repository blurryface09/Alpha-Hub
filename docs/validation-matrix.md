# Validation Matrix

## Supported Execution Chains

```js
SUPPORTED_EXECUTION_CHAINS = new Set(['eth', 'base', 'apechain', 'bnb', 'sepolia', 'base-sepolia'])
```

| Chain | Key | Chain ID | RPC Env Var | Strike | Auto-Mint |
|-------|-----|----------|-------------|--------|-----------|
| Ethereum | `eth` | 1 | `ETH_RPC_URL` | ✓ | ✓ |
| Base | `base` | 8453 | `BASE_RPC_URL` | ✓ | ✓ |
| ApeChain | `apechain` | 33139 | `APECHAIN_RPC_URL` | ✓ | ✓ |
| BNB Smart Chain | `bnb` | 56 | `BNB_RPC_URL` | ✓ | ✓ |
| Sepolia (testnet) | `sepolia` | 11155111 | `SEPOLIA_RPC_URL` | ✓ | Test only |
| Base Sepolia | `base-sepolia` | 84532 | (uses Base RPC) | ✓ | Test only |

Discovery-only (no execution): Solana, other L2s, non-EVM chains.

---

## Mint Protocol Support

| Protocol | Detection method | Execution method | Router address |
|----------|-----------------|-----------------|---------------|
| SeaDrop v1 | `isSeaDropContract(abi)` or blind probe | `mintPublic` / `mintAllowList` via SeaDrop router | `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` |
| Generic ERC-721/1155 (verified) | Etherscan ABI | `candidatesFromAbi()` | Contract directly |
| Generic ERC-721/1155 (unverified) | — | `fallbackCandidates()` | Contract directly |
| Captured (any protocol) | `mint_capture_profiles` | Stored calldata | Stored router |
| SeaDrop v2 | Not supported | — | — |
| Manifold | Capture Mode only | Via captured profile | — |
| Zora | Capture Mode only | Via captured profile | — |
| Magic Eden EVM | Not supported | — | — |

---

## Execution Status Values

### prepared_execution_status

| Value | Meaning | Strike allowed | Badge |
|-------|---------|----------------|-------|
| `public_live` | SeaDrop public drop active | Yes | Alpha Mint Ready (green) |
| `captured_ready` | Execution profile pre-loaded | Yes | Profile Captured (purple) |
| `allowlist_ready` | Stub wallet used, real wallet may have proof | Yes | Allowlist Ready (cyan) |
| `waiting_public_drop` | SeaDrop configured, not yet open | Pre-arm only | Waiting Drop (amber) |
| `ready` | Generic contract: gas estimates pass | Yes | Alpha Mint Ready |
| `proof_unavailable` | Allowlist exists, proof API unavailable | No | Official Mint (red) |
| `wallet_not_eligible` | Wallet not on allowlist | No | — |
| `signed_mint_only` | Requires OpenSea session signature | No | Session Required (orange) |
| `allowlist_only` | No public drop, allowlist phase only | No | Official Mint (red) |
| `unsupported_contract` | SeaDrop ended or state read failed | No | — |
| `unsupported_execution` | Cannot build valid calldata | No | Official Mint (red) |
| `router_required` | Needs router not yet supported | No | — |
| `captcha_required` | Captcha-gated mint | No | — |
| `not_probed` | No check performed yet | — | — |

### execution_status (simpler UI state)

| Value | Meaning |
|-------|---------|
| `live` | Contract can be executed now |
| `not_started` | Execution path confirmed, mint not open |
| `allowlist_ready` | On allowlist, can execute |
| `proof_unavailable` | On allowlist, proof unavailable |
| `wallet_not_eligible` | Not on allowlist |
| `signed_mint_only` | Session-signed mint |
| `unsupported_contract` | Cannot execute |
| `sold_out` | Mint sold out |
| `paused` | Contract paused |

---

## Fallback Function Candidates

Tried in order when no verified ABI or captured profile exists:

| Function | Signature | Notes |
|----------|-----------|-------|
| `mint` | `mint(uint256)` | Most common ERC-721 |
| `publicMint` | `publicMint(uint256)` | Manifold-style |
| `mintPublic` | `mintPublic(uint256)` | Non-SeaDrop variant |
| `allowlistMint` | `allowlistMint(uint256)` | |
| `presaleMint` | `presaleMint(uint256)` | |
| `purchase` | `purchase(uint256)` | Art Blocks style |
| `claim` | `claim(uint256)` | |
| `safeMint` | `safeMint(uint256)` | |
| `mint` | `mint(address,uint256)` | Address+qty variant |
| `mint` | `mint()` | No-arg free mint |
| `purchase` | `purchase()` | No-arg purchase |

---

## SeaDrop Allowlist Proof Sources

| Source | Method | Notes |
|--------|--------|-------|
| `opensea_api` | OpenSea allowlist API | Primary source |
| `ipfs_json` | Etherscan events → allowListURI → IPFS JSON | Fallback for direct IPFS lists |
| `on_chain_merkle` | Local merkle computation from IPFS data | Fallback when API unavailable |

Proof fetch order (in `fetchSeaDropAllowlistProof`):
1. Fetch Etherscan `AllowListUpdated` event logs for the contract
2. Get `allowListURI` from most recent event
3. Try IPFS gateways (ipfs.io → cloudflare-ipfs → pinata)
4. Parse JSON: `[{ address, mintParams }]` format
5. Compute merkle tree locally, find wallet index, generate proof

---

## Capability State Machine

```
Contract address + chain entered
           │
           ▼
   probeCapability()
           │
    ┌──────┴──────────────┐
    │ SeaDrop detected?   │
    └──────┬──────────────┘
      Yes  │           No
           │           │
           ▼           ▼
    ┌─────────┐  ┌────────────────┐
    │isActive?│  │ candidatesFromAbi │
    └─���──┬────┘  │  or fallbacks   │
    Yes  │  No   └────────┬───────┘
         │       │        │ gas ok?
    public│  startTime    │
    _live │  > now:       ├─ yes → 'ready'
         │  waiting       └─ no  → 'unsupported'
         │  _public_drop
         │
    startTime=0:
    allowlist_only /
    allowlist_ready /
    signed_mint_only
```

---

## Environment Variable Validation

| Variable | Missing behavior | Required for |
|----------|-----------------|--------------|
| `ETH_RPC_URL` | Falls back to `https://ethereum.publicnode.com` | ETH execution |
| `BASE_RPC_URL` | Falls back to `https://mainnet.base.org` | Base execution |
| `ETHERSCAN_API_KEY` | ABI fetch skipped; falls to fallback candidates | Verified ABI, allowlist events |
| `WALLET_ENCRYPTION_KEY` | auto-mint returns `{ ok: false, error }` | All execution |
| `LIVE_EXECUTION_ENABLED` | Defaults to `false` (dry run) | Live execution |
| `CRON_SECRET` | Auth disabled (open endpoint) | Production security |
| `APP_URL` | GitHub Actions fails "Validate secrets" step | Workflow |
| `SUPABASE_SERVICE_ROLE_KEY` | Execution cache + intent writes disabled | Persistence |
