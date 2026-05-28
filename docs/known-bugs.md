# Known Bugs — Catalog

Bugs are numbered in the order they were discovered and fixed. All listed bugs are **resolved** unless noted.

---

## BUG-1 — automint_enabled strict-false check

**Status**: Fixed  
**File**: `api/auto-mint.js`  
**Test**: `uat-automint-bugs.test.js` BUG-1

**Problem**: `automint_enabled=null` and `automint_enabled=undefined` were passing the guard, causing auto-mint to fire on projects that never explicitly enabled it.  
**Fix**: Strict `=== true` check: `if (project.automint_enabled !== true) skip`.

---

## BUG-2 — mint_time_confirmed strict-false check

**Status**: Fixed  
**File**: `api/auto-mint.js`  
**Test**: `uat-automint-bugs.test.js` BUG-2

**Problem**: Same pattern as BUG-1. `null`/`undefined` values were treated as confirmed.  
**Fix**: Strict `=== true` check before queuing for execution.

---

## BUG-3 — Confirmation timeout double-fire prevention

**Status**: Fixed  
**File**: `api/auto-mint.js`  
**Test**: `uat-automint-bugs.test.js` BUG-3

**Problem**: When a submitted transaction timed out waiting for confirmation, `auto_mint_fired` was being reset to `false`, allowing the project to be re-queued and fired again. Could result in duplicate mints.  
**Fix**: On confirmation timeout, `auto_mint_fired` stays `true`. The submitted project is moved to a separate query (pending-confirmation path) to check receipt status.

---

## BUG-4 — StrikeReviewModal risk text with live execution

**Status**: Fixed  
**File**: `src/components/mint/StrikeReviewModal.jsx`  
**Test**: `uat-automint-bugs.test.js` BUG-4

**Problem**: The risk disclosure text in the modal did not correctly show "live execution enabled" when `LIVE_EXECUTION_ENABLED=true`, potentially misleading users about dry-run vs live mode.  
**Fix**: Modal correctly checks `liveExecEnabled` flag from simulation response.

---

## BUG-5 — Telegram approval on auto-mode project

**Status**: Fixed  
**File**: `src/components/mint/` (Telegram flow)  
**Test**: `uat-automint-bugs.test.js` BUG-5

**Problem**: Projects with `mint_mode=auto` were routing through the wallet-confirm flow instead of showing the auto-mode toast.  
**Fix**: Mode gate added before wallet confirmation — `mint_mode=auto` shows toast, `mint_mode=confirm` calls wallet.

---

## BUG-6 — SeaDrop contract misidentification

**Status**: Fixed  
**File**: `api/_lib/mint-engine.js` — `isSeaDropContract()`  
**Test**: `uat-automint-bugs.test.js` BUG-6

**Problem**: Regular contracts with `mintPublic(uint256)` (1-arg) were being misidentified as SeaDrop contracts. SeaDrop uses `mintPublic(address, address, address, uint256)` (4-arg, first arg is `address` type).  
**Fix**: `isSeaDropContract()` checks for 4 inputs with `inputs[0].type === 'address'`.

Also fixed: SeaDrop transactions must route to `SEADROP_ADDRESS` (the router), not the NFT contract directly. `toOverride: SEADROP_ADDRESS` is set in the candidate.

---

## BUG-7 — viem positional array for getPublicDrop

**Status**: Fixed  
**File**: `api/_lib/mint-engine.js` — `buildSeaDropCandidates()`, `probeCapability()`  
**Test**: `uat-automint-bugs.test.js` BUG-7  
**Discovered via**: ROCKATERAL public mint failure (May 2026)

**Problem**: `viem.readContract` calls `decodeFunctionResult` which returns a **positional array** (not a named object) when a function has multiple output values. The code accessed `drop.mintPrice`, `drop.startTime`, `drop.endTime` — all `undefined` on a plain array.

Result: `startTime = BigInt(undefined || 0n) = 0n`, making `isActive = startTime > 0n && ...` always `false`. Every SeaDrop public mint was treated as "not configured" regardless of on-chain state.

**Root cause** (viem source):
```js
// viem/_cjs/utils/abi/decodeFunctionResult.js line 22-23
if (values && values.length > 1)
    return values;  // ← plain Array, no named properties
```

**Fix**: Use positional indices:
```js
// getPublicDrop: [0]=mintPrice, [1]=startTime, [2]=endTime
const mintPrice = drop ? BigInt(drop[0] || 0n) : 0n
const startTime = drop ? BigInt(drop[1] || 0n) : 0n
const endTime   = drop ? BigInt(drop[2] || 0n) : 0n
```

**Affected in both**: `buildSeaDropCandidates` (line ~625) and `probeCapability` (line ~1058).

**Note**: `getSignedMintValidationParams` returns a single tuple output — viem returns `values[0]` which IS a named object (decoded by `decodeTuple`). Named access on that return is correct.

---

## BUG-8 — GitHub Actions cron dies before execution (bash -eo pipefail)

**Status**: Fixed  
**File**: `.github/workflows/auto-mint-cron.yml`  
**Discovered via**: Workflow always failing in 3-4 seconds

**Problem**: GitHub Actions runs `bash -eo pipefail` by default. When `curl` fails (DNS error, empty `APP_URL` secret), `set -e` kills the step immediately — before the `if [ "$STATUS" -lt 200 ]` check runs. The step shows no output, and the job appears to die "before execution".

Additionally, all 18 workflow runs showed `steps: []` due to a separate GitHub account billing issue (account locked — no runners assigned).

**Fix**: `set +e` / `set -e` sandwich around curl, plus:
- Separate "Validate secrets" step with actionable error message
- `--connect-timeout 10 --max-time 55` to prevent hangs
- Response body captured to `/tmp/response_body.txt`
- Secrets passed via `env:` block (not inline YAML expansion)

**Note**: The `steps: []` failure is a GitHub billing issue — resolve at github.com/settings/billing.

---

## BUG-9 — Stale in-process nonce cache causes "nonce too low"

**Status**: Fixed  
**File**: `worker/lib/executor.js`  
**Commit**: `13a1dc6`  
**Discovered via**: Phase 1 E2E public mint validation (2026-05-27)

**Problem**: The worker's in-memory `nonceTracker` (module-level `Map`) persists across intent executions within the same Railway process lifetime. If the vault wallet sends transactions outside the worker (e.g., the E2E test script deploying a contract), the cached nonce becomes stale. All subsequent broadcast attempts fail with `nonce too low: next nonce N, tx nonce 0`.

The error was further masked because all three RPC providers rejected the tx, and the last provider's error (`HTTP 526`) caused viem to surface "An unknown RPC error occurred" — hiding the real cause from the retry classifier, which kept retrying instead of refreshing the nonce.

**Fix**: Fetch `eth_getTransactionCount(pending)` and seed `nonceTracker` at the start of every intent execution, before entering `withRetry`. The tracker still handles atomic increments within the retry cycle.

---

## BUG-10 — Base gas fee inflation (hardcoded Ethereum priority fee)

**Status**: Fixed  
**File**: `worker/lib/gas.js`  
**Commit**: `1d94f49`  
**Discovered via**: Phase 1 E2E public mint validation (2026-05-27)

**Problem**: Priority fee constants were calibrated for Ethereum mainnet (balanced = 1.5 gwei). On Base (typical base fee ~0.007 gwei), this produced `maxFeePerGas = 1.514 gwei` — 200× the actual market rate. For an 80k-gas mint, the required balance was `0.000121 ETH` before any escalation. After 3 gas escalations (1.25× each), it reached `0.000236 ETH`, exceeding a wallet funded with just $0.20.

**Fix**: Cap the priority fee at `min(strategyFee, max(baseFee × 2, 0.001 gwei))`. On Base this yields `0.014 gwei`; on Ethereum mainnet (base fee ~20+ gwei) the cap is `40+ gwei` — no effect on existing behaviour.

---

## BUG-11 — E2E test: `pending` treated as terminal state

**Status**: Fixed  
**File**: `worker/test/e2e-public-mint.test.mjs`  
**Commit**: `c7ebe18`  
**Discovered via**: Phase 1 E2E public mint validation (2026-05-27)

**Problem**: The test's terminal-state set included `pending`. The intent enters `pending` when the tx is broadcast but before it's confirmed on-chain. Stopping the poll at `pending` caused the ownership check to read `balanceOf = 0` even though the tx was in-flight and would succeed seconds later.

**Fix**: Remove `pending` from the terminal set. The poll continues until `success`, `failed`, `expired`, or `cancelled` — states that reflect a fully settled outcome.

---

---

## BUG-12 — ExecutionMonitor query: column `mint_contract_address` does not exist

**Status**: Fixed  
**File**: `api/admin/[action].js` — monitor intent SELECT  
**Discovered via**: ExecutionMonitorPage showing Supabase error instead of intent list (2026-05-28)

**Problem**: The admin monitor endpoint selected `mint_contract_address` from `mint_intents`, but that column doesn't exist. The correct column is `contract_address`. Additionally, `call_data` was not included in the SELECT, making the prewarm badge on the front-end always show nothing.

**Fix**: Removed `mint_contract_address` from SELECT; added `call_data`.

---

## BUG-13 — Telegram boot alert: `403 Forbidden: the bot can't send messages to the bot`

**Status**: Fixed  
**File**: `worker/strike-engine.js` — boot alert  
**Discovered via**: Railway logs showing `private_fallback` after first boot (2026-05-28)

**Problem**: `ADMIN_TELEGRAM_CHAT_ID` was set to the bot's own Telegram user ID (obtained from an early @userinfobot check that returned bot info instead of the admin's personal info). Telegram does not allow a bot to send messages to itself.

**Fix**: Use the admin's **personal** Telegram user ID. Obtained by sending `/start` directly to @userinfobot as the admin user (not via the bot). Admin's personal ID: `7737024288`.

**Note**: `TELEGRAM_BOT_TOKEN` must also be in the Railway worker service env vars (separate from Vercel). It's needed in both places for different purposes.

---

## BUG-14 — queue.test.js stale transition assertion

**Status**: Fixed  
**File**: `worker/test/queue.test.js`  
**Discovered via**: Test audit (2026-05-28)

**Problem**: A test asserted that `armed → retrying` is an invalid transition and expected an error. But `armed → executing` is valid (that's exactly what `claimIntent` does — it atomically flips `armed` to `executing`). The test was asserting the wrong transition.

**Fix**: Changed the invalid-transition test to use `armed → retrying` (actually invalid) instead of the originally intended but wrong transition.

---

## BUG-15 — e2e smoke test: Supabase mock `then()` not applying patches

**Status**: Fixed  
**File**: `worker/test/e2e-smoke.test.js` — `createMockDb()`  
**Discovered via**: Prewarm test showing call_data not written back (2026-05-28)

**Problem**: `prewarmIntent` uses `.update({...}).eq('id', id).then(r => r, () => null)` — passing two callbacks to `.then()`. The mock's `then()` only returned the stored rows array; it didn't apply the patch from `.update()`. The prewarm writes appeared to succeed (no error) but the in-memory DB never updated.

**Fix**: Mock's `then()` checks `_patch` and `_insert` state first. If a patch is pending (from `.update()`), it applies the diff to matching rows and resolves with `{ data: null, error: null }`. If an insert is pending, it appends to the array. Normal reads fall through to the array.

---

## Open / Watch List

| Issue | Status | Notes |
|-------|--------|-------|
| `loadCachedExecution` never called | Watch | Supabase cache written but never read back — cross-instance warmup doesn't work |
| SeaDrop v2 not supported | Known gap | Only SeaDrop v1 (`0x00005EA...`) |
| `minterIfNotPayer` hardcoded to zero | Accepted | Valid for standard mints; may need change for some collections |
| Vercel Hobby 12-function limit | Active constraint | Capture merged into calendar handler |
| Multi-wallet fan-out | Future | Single vault wallet per intent; bots fan out across many wallets |
