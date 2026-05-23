# Mint Engine Reference

**File**: `api/_lib/mint-engine.js`  
**Entry point**: `export async function prepareMintTransaction(body)`  
**Router**: `export async function handleMintAction(req, res, action)`

---

## prepareMintTransaction — Core Logic

### Input

```js
body = {
  contractAddress,  // required: 0x...
  walletAddress,    // required: 0x... (stub OK for simulation)
  chain,            // 'eth' | 'base' | 'apechain' | 'bnb' | 'sepolia'
  quantity,         // BigInt or number, defaults to 1
  mintPrice,        // ETH string e.g. '0.0025' (used for non-SeaDrop value)
  functionName,     // optional hint — promotes candidate to front
  rpcUrl,           // optional RPC override
  executionProfile, // optional: { avg_gas, timeout_ms, ... }
}
```

### Execution Path

```
1. getCachedExecution(contract, chain)
   → hit: try fast path with cached functionName
   → miss: continue

2. getCode(contract) — verify contract exists

3. fetchVerifiedAbi(contract, chain)
   → Etherscan v2 API → parse ABI

4. Protocol detection (priority order):
   a. isSeaDropContract(abi)  → buildSeaDropCandidates()
   b. blind SeaDrop probe     → buildSeaDropCandidates() (unverified contracts)
   c. candidatesFromAbi(abi)  → ABI-derived candidates
   d. fallbackCandidates()    → common function names

5. For each candidate:
   a. encodeFunctionData()
   b. estimateGas({ account, to, data, value })
   c. success → setCachedExecution(), return result
   d. fail    → log candidate_fail, try next

6. All candidates exhausted → throw with last error reason
```

### Output

```js
{
  to,            // contract or SeaDrop router address
  data,          // encoded calldata
  value,         // BigInt wei
  chainId,
  gas,           // estimated gas (string)
  functionName,
  argsSummary,   // string[] for logging
  source,        // 'seadrop' | 'verified_abi' | 'fallback' | ...
  cacheHit,
  latencyMs,
  rpcLabel,
}
```

---

## SeaDrop Path — buildSeaDropCandidates

**Contract**: `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` (SeaDrop v1, ETH mainnet)

### On-chain reads (parallel)

```js
getAllowedFeeRecipients(nftContract)  → address[]       (index 0)
getPublicDrop(nftContract)            → array[6]        (positional!)
getAllowListMerkleRoot(nftContract)   → bytes32
```

**CRITICAL**: viem `decodeFunctionResult` returns a positional array for multi-output functions.  
`getPublicDrop` indices: `[0]=mintPrice, [1]=startTime, [2]=endTime, [3]=maxMintable, [4]=feeBps, [5]=restrictFeeRecipients`  
Do NOT use named access (`drop.mintPrice`) — always use `drop[0]`, `drop[1]`, `drop[2]`. (BUG-7)

### isActive logic

```js
const isActive = startTime > 0n && startTime <= now && (endTime === 0n || endTime > now)
```

`endTime === 0n` = no end restriction (valid).  
`startTime === 0n` = public drop not configured (NOT the same as "always active").

### Decision tree

```
isActive?
├── yes → mintPublic(nftContract, feeRecipient, 0x0000...0000, quantity)
│         value = mintPrice * quantity
│         to    = SEADROP_ADDRESS
│
└── no, startTime===0 && feeRecipients.length>0
    ├── merkleRoot exists → fetch proof → mintAllowList(...)
    │   ├── proof found   → return allowlist candidate
    │   ├── wallet ineligible → throw 'wallet not eligible'
    │   └── proof unavailable → throw 'SeaDrop proof unavailable'
    ├── no merkle root, signed params → throw 'SeaDrop signed mint'
    └── neither → throw 'SeaDrop allowlist only'

no, startTime > now → throw 'Mint starts at <ISO time>'
no, endTime < now  → throw 'Mint ended at <ISO time>'
```

### Fee recipient selection

```js
const feeRecipients = getAllowedFeeRecipients(nftContract)  // on-chain
const feeRecipient  = feeRecipients[0] || SEADROP_FEE_RECIPIENT_FALLBACK
// SEADROP_FEE_RECIPIENT_FALLBACK = '0x0000a26b00c1F0DF003000390027140000fAa719'
```

---

## Candidate Sources

| Source | When used | `source` tag |
|--------|-----------|-------------|
| SeaDrop (confirmed ABI) | `isSeaDropContract(abi) === true` | `'seadrop'` |
| SeaDrop (blind probe) | No verified ABI, probe succeeds | `'seadrop'` |
| Verified ABI | Etherscan returns verified ABI | `'verified_abi'` |
| Fallback | No ABI available | `'common.<fn>'` |
| Cache hit | `getCachedExecution` warm | `'cache'` |
| Captured profile | `mint_capture_profiles` match | `'captured'` |

### fallbackCandidates — Tried functions

`mint(uint256)`, `publicMint(uint256)`, `mintPublic(uint256)`, `allowlistMint(uint256)`, `presaleMint(uint256)`, `purchase(uint256)`, `claim(uint256)`, `safeMint(uint256)`, `mint(address,uint256)`, `mint()`, `purchase()`

---

## probeCapability — Readiness Check

**Input**: `(contract, chain, quantity, walletAddress, clientOverride)`  
**Returns**: `{ prepared_execution_status, functionName, details, startTime?, mintPrice? }`

| Return status | Meaning |
|--------------|---------|
| `public_live` | SeaDrop public drop active right now |
| `waiting_public_drop` | SeaDrop configured, startTime in future |
| `allowlist_only` | No public drop, startTime=0, fee recipients exist |
| `ready` | Non-SeaDrop: gas estimates pass with stub wallet |
| `unsupported_contract` | SeaDrop ended, or state read failed |

---

## handleMintAction — Action Map

| Action | Method | Description |
|--------|--------|-------------|
| `status` | GET | Prewarm status + capability for a contract |
| `prewarm` | POST | Warm execution cache without wallet |
| `readiness` | POST | Full readiness probe → `prepared_execution_status` |
| `prepare` | POST | Gas estimate + calldata for a specific wallet |
| `enable-strike` | POST | Arm Strike intent in Supabase |
| `stop` | POST | Disarm / cancel armed intent |
| `strike-simulate` | POST | Full simulation: vault check + prepare + capability |
| `strike-replay` | POST | Re-run prepare for an existing intent |
| `strike-rerun` | POST | Reset failed intent to `armed` for retry |
| `execute` / `confirm` | POST | Live execution (calls `auto-mint.js` logic) |

---

## Telemetry Log Keys

All logs use structured JSON objects. Searchable in Vercel runtime logs.

| Key | When emitted | Key fields |
|-----|-------------|------------|
| `[mint-benchmark] cache_hit` | Fast path used | `fn, successCount` |
| `[mint-benchmark] cache_stale` | Fast path failed | `fn` |
| `[mint-benchmark] seadrop_detected` | SeaDrop path active | `mintPrice, startTime, endTime, isActive` |
| `[mint-benchmark] seadrop_blind_detected` | Unverified SeaDrop found | `contract, chain` |
| `[mint-benchmark] seadrop_blind_miss` | Blind probe failed | `contract, chain` |
| `[mint-benchmark] candidates` | Candidate list built | `protocolCount, abiCount, fallbackCount` |
| `[mint-benchmark] candidate_fail` | Gas estimate failed for one candidate | `fn, source, error` |
| `[mint-benchmark] success` | Winning candidate found | `fn, source, gas, attempts, duration_ms` |
| `[mint-path-trace]` | Full execution trace | `contract, chain, abi_source, selected_fn, selected_args, msg_value, calldata, router_target, gas_estimate, outcome` |
| `[capability-check]` | probeCapability result | `seadrop, confirmed, startTime, endTime, isActive` |
| `[allowlist-proof]` | Proof fetch result | `phase, proof_found, source, failure_reason` |
| `[strike-prep]` | Arm simulation stages | `stage, contract, chain, prepared_status, fn` |

---

## Execution Tracing Workflow

To trace a mint failure end-to-end:

1. **Find the relevant log block** — search Vercel runtime logs for the contract address (first 10 chars): `contract.slice(0, 10)`

2. **Check `[mint-benchmark] seadrop_detected`** — confirms SeaDrop path ran. Verify:
   - `isActive: true` — if false, check `startTime` and `endTime` values
   - `mintPrice` — must be non-zero for paid mints

3. **Check `[mint-benchmark] candidates`** — confirms how many candidates were built. `protocolCount: 0` with a SeaDrop contract means `buildSeaDropCandidates` threw.

4. **Check `[mint-benchmark] candidate_fail`** — lists the exact revert reason per function tried.

5. **Check `[mint-path-trace]`** — present only on success. Contains the exact `calldata`, `msg_value`, `router_target`, and `gas_estimate`.

6. **Check `[strike-prep]`** — for Strike arm failures. `stage: 'prepare_ok'` = prepare succeeded. Any other stage = where it failed.

### Common failure patterns

| Symptom | Log pattern | Likely cause |
|---------|------------|--------------|
| `isActive: false` but mint is live | `seadrop_detected: isActive=false, startTime=0` | `getPublicDrop` returned wrong data — check viem positional index access |
| All candidates fail with `000` status | `candidate_fail` repeated for all fns | Wrong value (mintPrice mismatch) or wrong contract |
| `proof_unavailable` | `allowlist-proof: failure_reason=api_unavailable` | OpenSea allowlist API down |
| `wallet_not_eligible` | `allowlist-proof: failure_reason=not_eligible` | Wallet not on the allowlist |
| Strike arm shows no steps | GitHub Actions `steps: []` | GitHub billing issue |
