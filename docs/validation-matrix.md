# Validation Matrix

---

## AlphaHubValidationNFT Scenario Results

Contract: `0x1ee151e31999bd8441f6c1ab221f66cd2c8bbde7` (Base mainnet)  
Owner/deployer wallet: `0x3e0101138e8c6c77371a0258a43949b99c4cc521`

| Scenario | Goal | Result | TX |
|----------|------|--------|----|
| A — Free mint | Basic Strike pipeline, free mint | ✅ PASS | `0x43cd7e2d...` block 46541462 |
| B — Paid mint | `value > 0`, inline price detection | ✅ PASS | `0xe9e89441...` block ~46631xxx |
| C — Timing gate | `startTime` gate, ≤1s execution drift | ✅ PASS | `0x0dc05aba...` block 46631152, T+0.7s |
| D — Supply cap | Supply exhausted after N mints | ⚠️ BUG-12 found (nonce collision — fixed, re-run needed) | — |

---

## Phase 1 Milestone — First Production Public Mint ✅

**Date**: 2026-05-27  
**Chain**: Base mainnet (chain ID 8453)  
**Milestone**: First successful end-to-end public mint through the full Strike pipeline on mainnet.

| Field | Value |
|-------|-------|
| Contract | `0xddc3310cb0dfbf9ad973834a2a0d12002ba747e0` (TestMintNFT, deployed same run) |
| Intent ID | `2279cdfc-7794-44aa-8fba-511d43895c74` |
| Tx hash | `0x43cd7e2d5ed8cc07bfc0627fe382f1aa658ff68d876afc2458ab97f5e6a0a951` |
| Block | 46541462 |
| Gas used | 73,061 |
| Elapsed | 113.7 s (arm → confirmed) |
| State flow | `armed → executing → success` |
| Explorer | [basescan.org](https://basescan.org/tx/0x43cd7e2d5ed8cc07bfc0627fe382f1aa658ff68d876afc2458ab97f5e6a0a951) |

**Verified during this run**:

| Check | Result |
|-------|--------|
| Vault wallet creation & DB load | ✅ |
| Wallet decryption (AES-256-GCM) | ✅ |
| Prewarm calldata path (`call_data` fast-path) | ✅ |
| Worker atomic claim (`armed → executing`) | ✅ |
| On-chain nonce sync before broadcast | ✅ (BUG-9 found & fixed) |
| Gas strategy (Base-appropriate fee) | ✅ (BUG-10 found & fixed) |
| Tx broadcast via Alchemy | ✅ |
| Receipt polling & confirmation | ✅ |
| Intent state → `success` | ✅ |
| `balanceOf(vault) = 1` | ✅ |
| `ownerOf(1) = vault wallet` | ✅ |
| Telemetry chain (6 events) | ✅ |

---

## Vault & Portfolio — Validation Checklist

| Check | Method | Status |
|-------|--------|--------|
| Portfolio page loads at `/portfolio` | Navigate in browser | — |
| Vault wallets appear with ETH/Base balances | `/api/vault/list` → wallet cards | — |
| Connected wallet NFTs visible (ETH + Base) | Alchemy `getNFTsForOwner` | — |
| Alpha Vault NFTs visible with VAULT badge | Alchemy fetch for vault address | — |
| "Withdraw" button appears on vault NFTs only | `canWithdraw = walletType === 'vault'` | — |
| Withdraw modal shows correct from/to addresses | UI check | — |
| ERC721 withdrawal: tx submitted, NFT moves | POST `/api/vault/withdraw` (type=erc721) | — |
| Ownership check enforced server-side | Try with wrong `vaultWalletId` → 403 | — |
| Private key never returned in response | Inspect network tab — only `txHash` returned | — |
| Withdrawal logged to `mint_log` | Query `mint_log WHERE status LIKE 'withdrawal%'` | — |
| History feed shows mints + withdrawals | `/portfolio` history section | — |
| "Withdraw" in Settings links to Portfolio | Settings page → Withdraw button | — |

---

## Phase 2 Validation Plan

### P2-1 — Paid public mint ✅

**Result**: PASSED (2026-05-29)  
TX: `0xe9e89441b3cf554d7e354ebe97c4b28d73c0c11813d1bbb488353e0d3f3ea1c5`  
Chain: Base · Gas: ~3s end-to-end · `private_ok` (Flashbots active)

**What worked**: Worker detected `value=0.00001 ETH` inline (`Paid mint detected — retrying with on-chain price`), included correct ETH value in tx, contract confirmed, NFT minted to vault.

**Goal**: Confirm the Strike pipeline handles `value > 0` mints correctly — gas + value doesn't exceed balance, the payment reaches the contract, and the NFT is minted to the vault wallet.

**Pass criteria**: NFT minted, tx confirmed, correct ETH deducted from vault wallet. ✓

---

### P2-2 — SeaDrop public mint

**Goal**: Validate the SeaDrop detection → `mintPublic` → SeaDrop router path end-to-end on mainnet.

**Approach**:
1. Identify an active SeaDrop v1 collection on Base or Ethereum.
2. Run `prepareMintTransaction` via the prewarm path to confirm `prepared_execution_status = public_live`.
3. Arm via Strike UI. Worker should execute via SeaDrop router (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`).
4. Verify: receipt confirmed, NFT ownership.

**Pass criteria**: Tx `to` = SeaDrop router, NFT minted to vault wallet.

---

### P2-3 — UI-driven Strike validation

**Goal**: Prove the full user flow — from project page → Strike → execution — works without any direct DB manipulation.

**Approach**:
1. Open a live mint project in the Alpha Hub UI.
2. Click "Strike" — review modal appears.
3. Confirm → intent armed via API (not direct DB insert).
4. Monitor intent state in UI until `success`.
5. Verify tx on-chain and NFT ownership.

**Pass criteria**: Full UI flow completes without touching Supabase directly, receipt + ownership confirmed.

---

### Scenario D — FCFS Supply Cap Race

**Goal**: Arm N+1 Strike intents against a contract with maxSupply=N, verify N succeed and the last one fails with supply exhausted.

**What happened (2026-05-29)**:
- Contract set to `maxSupply=24` (minted=22, 2 slots left)
- 3 intents armed simultaneously with same `strike_execute_at`
- All 3 transitioned to `executing` at T+1s ✓
- On-chain: only 2 txs mined, `minted→24/24` ✓ (supply cap enforced)
- **BUG-12**: Slot 3 reported as `success` with Slot 1's tx hash instead of `failed`

**Root cause (BUG-12)**: Concurrent executors sharing a wallet all read the same nonce from `nonceTracker`. Slot 3 got nonce N (same as Slot 1), broadcast the same raw tx (identical sender+nonce+data = identical hash), got H1 back from the RPC, and `waitForReceiptWithRecovery` found H1 confirmed → intent marked `success`.

**Fix**: In `worker/lib/executor.js` Step 8, advance the tracker *before* `await sendTransaction` (`nonceTracker.set(addr, nonce + 1)`) and only seed from chain in Step 6b if the tracker has no entry for this wallet (prevents concurrent syncs from overwriting each other's claimed slots).

**Status**: Fix committed. Re-run Scenario D required after Railway deploy.

---

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
