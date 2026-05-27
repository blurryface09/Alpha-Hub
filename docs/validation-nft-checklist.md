# AlphaHubValidationNFT — Testing Checklist

Permanent testing contract for Alpha Hub end-to-end validation.  
Every release should pass all scenarios against this contract before production.

---

## Contract

**Name**: AlphaHubValidationNFT (`AHVAL`)  
**File**: `contracts/AlphaHubValidationNFT.sol`  
**Deployments**: `contracts/deployments/`

### Key addresses

| Network | Address | Explorer |
|---------|---------|---------|
| Base Sepolia | *(run deploy script — see below)* | [sepolia.basescan.org](https://sepolia.basescan.org) |
| Base mainnet | *(deploy after Sepolia validation)* | [basescan.org](https://basescan.org) |

---

## One-time setup

### 1. Deploy to Base Sepolia

```bash
node scripts/deploy-validation-nft.mjs
```

Options:
```bash
# Free mint, no time restriction, unlimited supply, activate immediately
node scripts/deploy-validation-nft.mjs --active

# Paid mint at 0.001 ETH, max 1000 supply
node scripts/deploy-validation-nft.mjs --price 0.001 --supply 1000 --active

# Delayed start (60 seconds from now), free
node scripts/deploy-validation-nft.mjs --delay 60 --active
```

Saves to `contracts/deployments/latest-base-sepolia.json`.

### 2. Fund the vault wallet (Base Sepolia)

The vault wallet needs Base Sepolia ETH for gas. Get free testnet ETH from:
- https://faucet.quicknode.com/base/sepolia
- https://www.coinbase.com/faucets/base-ethereum-goerli-faucet

### 3. Verify the deployment

```bash
node scripts/verify-validation-nft.mjs
```

Expected output:
- ✓ Contract responding
- ✓ Caller is owner
- ✓ Free mint scenario passes

---

## Validation scenarios

### Scenario A — Free mint

Tests the basic pipeline with `value = 0`.

```bash
node scripts/verify-validation-nft.mjs --scenario free
```

**Manual steps:**
1. Confirm `mintPrice = 0`, `mintActive = true`
2. Call `mint(1)` from the vault wallet
3. Verify `totalSupply` incremented by 1
4. Verify `balanceOf(vault)` incremented by 1
5. Verify `ownerOf(tokenId) = vault`

**Pass criteria**: `status=success`, NFT minted to vault wallet.

---

### Scenario B — Paid mint

Tests `value > 0` flow and incorrect-value revert.

```bash
node scripts/verify-validation-nft.mjs --scenario paid
```

**Manual steps:**
1. Call `setMintPrice(100000000000000)` (0.0001 ETH)
2. Call `mint(1)` with `value = 0.0001 ETH` → should succeed
3. Call `mint(1)` with `value = 0` → should revert with "wrong ETH"
4. Verify NFT minted
5. Call `setMintPrice(0)` to restore

**Pass criteria**: Correct-value mint succeeds, zero-value reverts.

---

### Scenario C — Delayed start (timing gate)

Tests the `startTime` gate — critical for Strike "arm before mint opens" use case.

**Manual steps:**
1. Call `setStartTime(block.timestamp + 120)` (2 minutes from now)
2. Call `mint(1)` immediately → should revert with "not started"
3. Wait 2 minutes
4. Call `mint(1)` → should succeed
5. Call `setStartTime(0)` to reset

**Admin commands:**
```javascript
// Set start time 2 minutes from now
const future = Math.floor(Date.now() / 1000) + 120
setStartTime(future)

// Reset
setStartTime(0)
```

**Pass criteria**: Pre-start revert, post-start success.

---

### Scenario D — FCFS / supply cap

Tests `maxSupply` enforcement.

**Manual steps:**
1. Note current `totalSupply` → N
2. Call `setMaxSupply(N + 2)`
3. Call `mint(1)` → succeeds (total = N+1)
4. Call `mint(1)` → succeeds (total = N+2, supply full)
5. Call `mint(1)` → reverts with "supply exhausted"
6. Call `setMaxSupply(0)` to restore unlimited

**Pass criteria**: Third mint correctly reverts.

---

### Scenario E — Strike pipeline

Tests the full worker pipeline: arm → claim → broadcast → confirm → ownership.

```bash
node scripts/verify-validation-nft.mjs --scenario strike
```

**Manual steps:**
1. Ensure `mintActive = true`, `mintPrice = 0`
2. In Alpha Hub UI (or DB), create a Strike intent against the contract
3. Set `strike_execute_at` 30–90 seconds out
4. Monitor intent status until `success`
5. Verify `balanceOf(vault) > 0`
6. Verify tx on Basescan

**Pass criteria**: `armed → executing → success`, NFT minted, receipt confirmed.

---

### Scenario F — UI-driven Strike

Tests the complete user flow through the Alpha Hub frontend.

**Steps:**
1. Open Alpha Hub UI
2. Add the validation contract as a project
3. Wait for prewarm / capability check (`prepared_execution_status = ready`)
4. Click "Strike" button
5. Review modal shows correct contract + chain
6. Confirm → intent created via API (no direct DB)
7. Monitor intent status chip in UI until green
8. Verify on Basescan

**Pass criteria**: Full flow without any manual DB intervention, receipt + ownership confirmed.

---

### Scenario G — Admin access control

Tests that only the contract owner can call admin functions.

**Manual steps:**
1. From a non-owner wallet, call `setMintPrice(999)` → should revert "not owner"
2. From owner wallet, call `setMintPrice(999)` → should succeed
3. Verify `mintPrice = 999` on-chain
4. Restore: `setMintPrice(0)`

**Pass criteria**: Non-owner reverts, owner succeeds.

---

## Release validation checklist

Run this checklist before every production release:

```
□ Scenario A — Free mint                    node scripts/verify-validation-nft.mjs --scenario free
□ Scenario B — Paid mint                    node scripts/verify-validation-nft.mjs --scenario paid
□ Scenario C — Delayed start               (manual — requires waiting)
□ Scenario D — FCFS supply cap             (manual)
□ Scenario E — Strike pipeline             node scripts/verify-validation-nft.mjs --scenario strike
□ Scenario F — UI-driven Strike            (manual — UI walkthrough)
□ Scenario G — Admin access control        (manual or semi-automated)
```

For a quick smoke test covering the most critical path:
```bash
node scripts/verify-validation-nft.mjs --scenario all
```

---

## Admin reference

All admin functions require the deployer wallet.

| Function | Args | Effect |
|---------|------|--------|
| `setMintActive(bool)` | `true`/`false` | Enable/disable mint |
| `setMintPrice(uint256)` | wei | Per-token price (0 = free) |
| `setStartTime(uint256)` | unix ts | 0 = no restriction |
| `setEndTime(uint256)` | unix ts | 0 = no restriction |
| `setMaxSupply(uint256)` | count | 0 = unlimited |
| `setMaxPerWallet(uint256)` | count | 0 = unlimited |
| `setMaxPerTx(uint256)` | 1–100 | Max per tx call |
| `withdraw()` | — | Send ETH balance to owner |
| `transferOwnership(address)` | new owner | Irreversible |

**Quick config presets:**

```bash
# Free FCFS mint, open now, max 500
setMintPrice(0)
setMaxSupply(500)
setStartTime(0)
setMintActive(true)

# Paid mint, opens in 1 hour
setMintPrice(1000000000000000)  # 0.001 ETH
setStartTime(<now + 3600>)
setMintActive(true)

# Emergency stop
setMintActive(false)
```

---

## Deployment to Base mainnet

Once all Sepolia scenarios pass:

```bash
node scripts/deploy-validation-nft.mjs --network mainnet --active
```

Saves to `contracts/deployments/latest-base.json`.

Then run Phase 2 validation:
```bash
node scripts/verify-validation-nft.mjs --network mainnet --scenario all
```
