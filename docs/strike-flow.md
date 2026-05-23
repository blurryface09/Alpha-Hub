# Strike Mode — Execution Flow

Strike Mode fires a mint transaction at a scheduled time using the user's Alpha Vault wallet, without requiring browser interaction at T=0.

---

## Lifecycle States

```
not_armed
    │
    ▼ POST /api/mint/enable-strike
armed  ──────────────────────────────────────────────► stopped
    │                                                 (POST /api/mint/stop)
    │  worker polls every 15s
    │  strike_execute_at ≤ now
    ▼
executing  (atomic claim: UPDATE WHERE status IN ('armed','prewarm'))
    │
    ├── prepareMintTransaction()
    │   ├── success → sendTransaction()
    │   │   ├── confirmed → minted
    │   │   ├── timeout  → re-check receipt → confirmed | failed
    │   │   └── revert   → failed (with revert reason)
    │   └── fail → failed
    │
    └── LIVE_EXECUTION_ENABLED=false → dry_run (no tx sent)
```

---

## Arm Phase — POST /api/mint/enable-strike

### Input (from StrikeReviewModal)

```js
{
  intentId?,        // update existing intent if present
  contractAddress,
  chain,
  quantity,
  mintPrice,
  mintDate,         // ISO string: strike_execute_at
  walletAddress,    // vault wallet (from loadVault())
  functionName?,    // hint from capture profile
}
```

### Steps

1. Load vault wallet (`alpha_vault_wallets` → decrypt key)
2. Load capture profile (`mint_capture_profiles` by contract+chain)
3. Call `prepareMintTransaction({ walletAddress: vault.address })`
   - SeaDrop: `buildSeaDropCandidates()` → gas estimate
   - Other: ABI candidates → gas estimate
4. Upsert `mint_intents` row:
   ```js
   {
     status: 'armed',
     strike_armed_at: now,
     strike_execute_at: mintDate,
     prepared_tx: { to, data, value, gas, functionName },
     prepared_execution_status,
   }
   ```
5. Return `{ ok, intent_id, simulation: { wallet_ready, prepared_execution_status, ... } }`

### Pre-arm bypass (captured profiles)

If `loadCaptureProfile()` returns a profile AND the error is not a hard block, the arm succeeds even if `prepareMintTransaction` fails — the profile will be used at execution time.

Hard blocks (prevent bypass): `signed_mint_only`, `captcha_required`, `router_required`, `unsupported_contract`, `unsupported_execution`

---

## Simulate Phase — POST /api/mint/strike-simulate

Used by `StrikeReviewModal` before the user arms. Returns full readiness picture.

### Response shape

```js
{
  ok: true,
  simulation: {
    wallet_ready: bool,
    contract_valid: bool,
    execution_status: 'live' | 'not_started' | ...,
    prepared_execution_status: 'public_live' | 'waiting_public_drop' | 'captured_ready' | ...,
    function_name: string | null,
    estimated_gas: string | null,
    blockers: string[],       // hard blocks — prevents arming
    warnings: string[],       // soft warnings — allow arm with caution
    live_execution_enabled: bool,
    capture_protocol?: string,
    capture_sample_count?: number,
  }
}
```

### StrikeReviewModal UI state resolution

| `prepStatus` | `execStatus` | UI state |
|-------------|-------------|----------|
| `public_live` | `live` | `ready` |
| `captured_ready` | any | `ready` |
| `waiting_public_drop` | `not_started` | `pre_arm` |
| `allowlist_ready` | any | `allowlist` |
| `proof_unavailable` | any | `proof_unavailable` |
| `signed_mint_only` | any | `signed_mint` |
| `unsupported_contract` | any | `unsupported` |
| any | any + blockers | `blocked` |

---

## Execute Phase — Worker / auto-mint.js

### Timing

```
strike_execute_at = T
PREWARM_WINDOW_MS = 30,000ms  (worker starts preparing 30s before T)

at T - 30s: prewarm starts (gas estimate, RPC warmup)
at T:       execute fires (isReadyToExecute checks EXECUTION_OFFSET_MS)
at T + X:   receipt polling (waitForReceiptWithRecovery)
```

### Transaction

```js
walletClient.sendTransaction({
  to:    intent.prepared_tx.to,   // SEADROP_ADDRESS or contract
  data:  intent.prepared_tx.data, // pre-encoded calldata
  value: BigInt(intent.prepared_tx.value),
  gas:   gasWithProfile,          // execution_optimizer applies gas buffer
  maxFeePerGas, maxPriorityFeePerGas,  // EIP-1559
  nonce: currentNonce,
})
```

### Retry logic

- `withRetry(fn, maxAttempts, delayMs)` — wraps sendTransaction
- Nonce escalation: re-fetch nonce on each attempt
- Gas escalation: `gasFromProfile()` adds buffer per retry

---

## Supabase Tables

### mint_intents

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | Primary key |
| `user_id` | uuid | Auth user |
| `contract_address` | text | The NFT contract |
| `chain` | text | `eth` \| `base` \| etc. |
| `status` | text | `draft` → `armed` → `executing` → `minted` \| `failed` |
| `strike_armed_at` | timestamptz | When arm was set |
| `strike_execute_at` | timestamptz | When to fire |
| `prepared_tx` | jsonb | `{ to, data, value, gas, functionName }` |
| `prepared_execution_status` | text | Last known capability state |
| `tx_hash` | text | Transaction hash (post-execution) |
| `strike_error` | text | Last error message |
| `vault_wallet_id` | uuid | FK to alpha_vault_wallets |

### mint_attempts

Per-attempt record. Multiple rows per intent (retries).

| Column | Notes |
|--------|-------|
| `intent_id` | FK to mint_intents |
| `status` | `submitted` \| `confirmed` \| `failed` |
| `tx_hash` | Tx hash (may be null on failure) |
| `gas_used` | Actual gas consumed |
| `error_message` | Raw revert or error |

---

## Capability Badge States

Defined in `src/components/mint/CapabilityBadge.jsx` and `src/lib/mintRestrictions.js`.

| Status | Badge | Strike allowed |
|--------|-------|---------------|
| `public_live` | Alpha Mint Ready (green) | Yes |
| `captured_ready` | Profile Captured (purple) | Yes |
| `waiting_public_drop` | Waiting Drop (amber) | Pre-arm only |
| `allowlist_ready` | Allowlist Ready (cyan) | Yes |
| `proof_unavailable` | Official Mint (red) | No |
| `signed_mint_only` | Session Required (orange) | No |
| `allowlist_only` | Official Mint (red) | No |
| `unsupported_contract` | — | No |
| `wallet_not_eligible` | — | No |
