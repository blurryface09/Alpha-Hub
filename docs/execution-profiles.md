# Execution Profiles

Two distinct profile systems track learned execution data:

1. **`mint_contract_cache`** — which function works for a contract (hot path)
2. **`mint_capture_profiles`** — full execution profile from Capture Mode or auto-learn

---

## mint_contract_cache — Execution Cache

**File**: `api/_lib/contract-cache.js`  
**Layer 1**: In-memory Map (per serverless instance, cold-start cleared)  
**Layer 2**: Supabase `mint_contract_cache` table (persistent)

### TTLs

| Cache | TTL | Purpose |
|-------|-----|---------|
| ABI cache | 1 hour | Verified ABI per contract |
| Exec cache | 24 hours | Working function config |
| Probe cache | 15 minutes | Execution status (changes fast) |

### In-memory entry shape

```js
{
  functionName: 'mintPublic',
  argsSummary: ['1'],
  gas: '185000',
  chainId: 1,
  source: 'seadrop' | 'verified_abi' | 'fallback' | 'db_cache',
  successCount: 3,
  lastLatencyMs: 280,
  at: Date.now(),
}
```

### Fast path behavior

When `getCachedExecution(contract, chain)` is warm:
- Looks up cached `functionName` in `fallbackCandidates()`
- If found: runs gas estimate immediately — skips ABI fetch + candidate iteration
- If gas estimate fails: logs `cache_stale`, falls through to full path (cache is NOT cleared — stale entry stays until TTL)

### Important: loadCachedExecution is imported but never called

`loadCachedExecution` exists in contract-cache.js and loads the Supabase `mint_contract_cache` into the in-memory map. It is currently **not called** anywhere in mint-engine.js. The Supabase table is written to (fire-and-forget via `setCachedExecution`) but never read back within the same process. The in-memory cache is the only active read path.

---

## mint_capture_profiles — Capture Mode Profiles

**Table**: `mint_capture_profiles`  
**Source**: Capture Mode UI (`CaptureModeModal.jsx`) + auto-learn on successful `prepare`

### Table columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | Primary key |
| `user_id` | uuid | Owner |
| `contract_address` | text | Lowercased |
| `chain` | text | |
| `selector` | text | 4-byte function selector |
| `mint_function` | text | Function name |
| `protocol` | text | `seadrop` \| `manifold` \| `zora` \| `highlight` \| `thirdweb` \| `custom` |
| `router_address` | text | Contract called (may differ from NFT) |
| `proof_shape` | jsonb | Proof/args structure |
| `gas_avg` | integer | Rolling average gas |
| `sample_count` | integer | How many successful executions |
| `source` | text | `capture` \| `auto_learn` |
| `updated_at` | timestamptz | |

### Auto-learn — When triggered

After a successful `prepareMintTransaction` in the `prepare` action:
```js
const isRealWallet = walletAddress !== '0x0000000000000000000000000000000000000001'
if (isRealWallet && preparedTransaction?.data && contract) {
  autoLearnCaptureProfile(...).catch(() => {})  // fire-and-forget
}
```

Stub wallet (`0x000...001`) never triggers auto-learn. Only real vault wallets do.

### Auto-learn — Profile built from

```js
{
  contract_address: contract (lowercased),
  chain,
  selector: calldata.slice(0, 10),  // '0x' + 4 bytes
  mint_function: functionName,
  protocol: classifiedProtocol,     // from KNOWN_ROUTERS + KNOWN_SELECTORS
  router_address: result.to,        // actual tx destination
  gas_avg: result.gas,
  sample_count: 1,
  source: 'auto_learn',
}
```

On update (same contract already exists): `sample_count` is incremented, `gas_avg` is rolling-averaged.

### loadCaptureProfile — Usage

Called in two places:
1. `enable-strike` arm action — pre-arm bypass if profile exists
2. `strike-simulate` — promotes `prepared_execution_status` to `captured_ready`

```js
const profile = await loadCaptureProfile(supabase, { contractAddress, chain })
// Returns: { mint_function, protocol, router_address, gas_avg, sample_count } | null
```

If profile exists and status is not a hard block:
- `prepared_execution_status` → `'captured_ready'`
- `functionName` hint passed to `prepareMintTransaction`

---

## Protocol Classification

**File**: `src/lib/mintProfiles.js`

### KNOWN_ROUTERS

| Address (lowercase) | Protocol | Name |
|---------------------|---------|------|
| `0x00005ea00ac477b1030ce78506496e8c2de24bf5` | `seadrop` | SeaDrop v1 |
| (others per mintProfiles.js) | manifold, zora, highlight, thirdweb | |

### KNOWN_SELECTORS

| Selector | Function | Protocol |
|----------|----------|---------|
| `0x6871ee40` | `mintPublic` | seadrop |
| `0x54ab11e9` | `mintAllowList` | seadrop |
| (others per mintProfiles.js) | | |

---

## Execution Optimizer

**File**: `api/_lib/execution-optimizer.js`  
**Table**: `mint_execution_optimizations` (separate from contract cache)

Tracks per-contract, per-chain optimization data: average gas, best RPC, timeout calibration. Used to tune gas buffers and RPC ordering at execution time.

Key exports:
- `loadExecutionProfile(supabase, { chain, contractAddress })` — loads optimization row
- `gasFromProfile(estimatedGas, profile)` — applies gas buffer from profile
- `rpcTimeoutMs(profile, fallback)` — calibrated timeout
- `orderRpcCandidates(chain, profile, candidates)` — best RPC first
- `recordExecutionOptimization(supabase, input)` — post-execution learning
