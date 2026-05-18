# Strike Engine Execution Architecture

## System Overview and Goals

The Strike Engine is the automated on-chain execution layer of Alpha Hub. It monitors a queue of user `mint_intents` and fires transactions at precisely the right moment — supporting scheduled mints, gas-optimised execution, and resilient retry logic.

**Goals:**
- Execute armed mint intents at scheduled times with millisecond precision
- Never send duplicate transactions (idempotent claim-and-lock)
- Fail safely — every error path leaves the intent in a defined state
- Support dry-run mode at all times (no live execution without explicit flag)
- Provide structured, queryable logs for every execution step

---

## Execution Lifecycle Diagram (ASCII)

```
Supabase mint_intents table
          │
          │  poll every 15s
          ▼
┌─────────────────────┐
│   fetchReadyIntents │ ◄── also: fetchPrewarmIntents (30s lookahead)
└────────┬────────────┘
         │ intents with strike_execute_at ≤ now
         ▼
┌─────────────────────┐
│    claimIntent      │  UPDATE status='executing' WHERE status IN (armed,...)
└────────┬────────────┘  ← atomic; null = already claimed by another worker
         │
         ▼
┌─────────────────────┐
│  loadExecutionWallet│  decrypt AES-256-GCM private key from alpha_vault_wallets
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│    estimateGas      │  getBlock → compute EIP-1559 params
└────────┬────────────┘  (strategy: safe / balanced / aggressive)
         │
         ▼
┌─────────────────────┐
│  isReadyToExecute?  │  timing check (EXECUTION_OFFSET_MS)
└────────┬────────────┘
    No ──┴── (prewarm window?) ──► log prewarm, requeue to 'armed'
         │ Yes
         ▼
┌─────────────────────┐
│LIVE_EXECUTION_ENABLED│
└────────┬────────────┘
    No ──┴──► DRY RUN LOG → requeue
         │ Yes
         ▼
┌─────────────────────┐
│  sendTransaction    │  withRetry wrapper
│  (walletClient)     │  nonce tracking + gas escalation per attempt
└────────┬────────────┘
         │
    ┌────┴────┐
    │ success │  tx hash → status='success', log event
    └─────────┘
    ┌────┴────┐
    │ failed  │  status='failed', strike_enabled=false, log event
    └─────────┘
```

---

## Intent State Machine

### States

| State       | Description                                              |
|-------------|----------------------------------------------------------|
| `pending`   | Intent created, not yet evaluated                        |
| `armed`     | Ready for execution, strike_enabled=true                 |
| `queued`    | Reserved for future queuing layer                        |
| `executing` | Atomically claimed by a worker; in-flight                |
| `retrying`  | Execution attempted, retrying after transient failure    |
| `success`   | Transaction submitted successfully                       |
| `failed`    | All retries exhausted or non-retryable error             |
| `expired`   | Execution window passed without success                  |
| `cancelled` | Manually or automatically cancelled                      |

### Valid Transitions

```
pending   → armed | cancelled | expired
armed     → queued | cancelled | expired
queued    → executing | cancelled | expired
executing → success | failed | retrying
retrying  → executing | failed
failed    → cancelled  (manual recovery)
```

---

## Arming Conditions

An intent is considered armable when all of the following are true:

1. `strike_enabled = true`
2. `status` is one of: `armed`, `watching`, `prepared` (legacy aliases honoured)
3. The intent has a valid `mint_contract_address` or `to` field
4. The associated `alpha_vault_wallets` row exists with `status='active'`
5. `AUTO_STRIKE_ENABLED=true` and `ALPHA_VAULT_ENABLED=true` (env safety flags)

---

## Queueing Logic

The main poll runs every `STRIKE_WORKER_INTERVAL_MS` (default 15s).

**Each tick:**
1. **Expiration sweep** — mark stale intents (past `INTENT_EXPIRY_AFTER_MS` = 5min) as `expired`
2. **Prewarm query** — fetch intents with `strike_execute_at` within the next 30s; log them so gas/wallet can be prepared
3. **Ready query** — fetch intents where `strike_execute_at IS NULL OR strike_execute_at <= now` (up to `STRIKE_WORKER_BATCH_SIZE`, default 3), ordered by `updated_at ASC`
4. **Execute** each ready intent sequentially

---

## Execution Flow (Step by Step)

1. **claimIntent** — `UPDATE mint_intents SET status='executing' WHERE id=? AND strike_enabled=true AND status IN ('armed','watching','prepared')` — returns null if raced
2. **loadExecutionWallet** — fetch vault row, decrypt AES-256-GCM private key, derive viem `Account`
3. **estimateGas** — call `getBlock('latest')` to read `baseFeePerGas`; compute `maxFeePerGas` and `maxPriorityFeePerGas` per strategy
4. **isReadyToExecute** — check `now >= strike_execute_at - EXECUTION_OFFSET_MS`; if not ready, check prewarm and requeue
5. **LIVE_EXECUTION_ENABLED gate** — if false, log dry-run details and requeue; never send
6. **Build tx** — `{ to, value, data, gas }` from intent fields
7. **withRetry(sendTransaction)** — tracks nonce, escalates gas on retry, records each attempt
8. **On success** — record `mint_attempts` row, transition to `success`, insert event with tx hash
9. **On final failure** — record attempt, transition to `failed`, set `strike_enabled=false`, insert event

---

## Retry Policy

| Error Type       | Retryable | Max Retries | Notes                                      |
|------------------|-----------|-------------|-------------------------------------------|
| `revert`         | No        | 0           | Contract execution revert — never retry   |
| `nonce_too_low`  | Yes       | 2           | Refresh nonce from chain before retry     |
| `gas_too_low`    | Yes       | 3           | Escalate gas 1.25× per attempt            |
| `timeout`        | Yes       | 4           | RPC timeout / abort                       |
| `network`        | Yes       | 4           | fetch failed, ECONNRESET, etc.            |
| `default`        | Yes       | 3           | Any other error                           |

**Backoff formula:** `min(500ms × 2^attempt + jitter(0–200ms), 15s)`

**Gas escalation on retry:** each retry multiplies `maxFeePerGas` and `maxPriorityFeePerGas` by **1.25×** (EIP-1559 replacement minimum is 1.10×).

**Nonce tracking:** an in-process `Map<address, nonce>` avoids redundant `eth_getTransactionCount` calls. On `nonce_too_low`, the nonce is refreshed from `eth_getTransactionCount(pending)`.

---

## RPC Infrastructure

### Providers per Chain

| Chain    | Env Variables                                          | Public Fallbacks                                |
|----------|--------------------------------------------------------|-------------------------------------------------|
| Ethereum | `ETH_RPC_URL`, `ETH_RPC_URL_FALLBACK_1`, `_FALLBACK_2` | llamarpc, ankr, cloudflare-eth                 |
| Base     | `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK_1`, `_FALLBACK_2`| mainnet.base.org, base.llamarpc.com            |
| BNB      | `BNB_RPC_URL`, `BNB_RPC_URL_FALLBACK_1`, `_FALLBACK_2` | bsc-dataseed.binance.org                       |
| ApeChain | `APECHAIN_RPC_URL`                                     | —                                               |

### Latency Scoring

Each URL maintains a health record:
```
{ latencyEma: number, failCount: number, lastCheck: timestamp }
```
- **EMA α = 0.3** — new sample weighted 30%, history 70%
- URLs with `failCount >= 3` are moved to the end of the list (deprioritised, not removed)
- `failCount` resets to 0 on any successful request
- All requests timeout after **8s** (configurable per call)

**Provider ordering:** healthy URLs sorted by EMA latency ascending, then degraded URLs.

---

## Gas Strategies

| Strategy    | maxPriorityFee | baseFee Multiplier | Legacy gasPrice Multiplier |
|-------------|---------------|-------------------|---------------------------|
| `safe`      | 1.0 gwei      | 1.5×              | 1.1×                      |
| `balanced`  | 1.5 gwei      | 2.0×              | 1.3×                      |
| `aggressive`| 3.0 gwei      | 2.5×              | 1.6×                      |

**Formula (EIP-1559):**
```
maxFeePerGas = ceil(baseFeePerGas × multiplier) + maxPriorityFeePerGas
```

For chains without `baseFeePerGas` in the block header, falls back to `eth_gasPrice × multiplier`.

Intent field `gas_strategy` overrides the default (`balanced`).

---

## Execution Timing

| Constant               | Default | Env Override            | Description                                    |
|------------------------|---------|-------------------------|------------------------------------------------|
| `PREWARM_WINDOW_MS`    | 30,000  | `PREWARM_WINDOW_MS`     | Start preparing wallet/gas 30s before execute  |
| `EXECUTION_OFFSET_MS`  | 0       | `EXECUTION_OFFSET_MS`   | Fire this many ms before/after execute_at      |
| `INTENT_EXPIRY_AFTER_MS`| 300,000| `INTENT_EXPIRY_AFTER_MS`| Mark expired if still pending 5min after execute_at |
| `MAX_CLOCK_DRIFT_MS`   | 2,000   | `MAX_CLOCK_DRIFT_MS`    | Tolerated clock skew between worker and DB     |

**Prewarm:** when an intent enters the 30s window before its execute time, the worker logs a prewarm event so observability tooling can verify readiness. No state change occurs; the intent stays `armed`.

**Expiry sweep:** runs once per tick. Intents with `strike_execute_at + INTENT_EXPIRY_AFTER_MS < now` are updated to `status='expired'` and `strike_enabled=false`.

---

## Wallet Model

### Current: Single Vault Wallet
- Loaded from `alpha_vault_wallets` by `intent.vault_wallet_id` (or user's most-recent active wallet)
- Private key encrypted with AES-256-GCM; salt = `user_id`, key derived via PBKDF2 (100,000 iterations, SHA-256)
- Format: `base64(iv[12] + tag[16] + ciphertext)`

### Future: Multi-Wallet (behind `MULTI_WALLET_ENABLED` flag)
- Load all `status='active'` wallets for the user
- Select the one with the oldest `last_used_at` (LRU rotation)
- Prevents hot-wallet nonce collisions across concurrent intents

### Future: Burner Wallet
- Generate ephemeral `privateKeyToAccount(generatePrivateKey())`
- Fund from a treasury, sweep after mint
- Use case: privacy-preserving one-shot mints

---

## Logging Schema

Every log line is a JSON object on stdout (errors to stderr):

```json
{
  "timestamp": "2026-05-18T12:00:00.000Z",
  "level": "info",
  "phase": "execute",
  "intent_id": "uuid",
  "user_id": "uuid",
  "message": "Intent executed successfully",
  "fields": {
    "tx_hash": "0x...",
    "latency_ms": 1234,
    "chain": "base",
    "gas_strategy": "balanced"
  }
}
```

### Phases

| Phase       | Description                                   |
|-------------|-----------------------------------------------|
| `boot`      | Worker startup / shutdown                     |
| `tick`      | Per-poll-loop events                          |
| `claim`     | Atomic intent claim                           |
| `prepare`   | Wallet load, key decrypt                      |
| `prewarm`   | Intent approaching execution window           |
| `gas`       | Gas estimation                                |
| `simulate`  | Pre-broadcast simulation / event logging      |
| `execute`   | Transaction send                              |
| `retry`     | Retry attempt                                 |
| `confirm`   | Post-broadcast confirmation (future)          |
| `success`   | Successful submission                         |
| `failed`    | Terminal failure                              |
| `expired`   | Intent expired without execution              |
| `cancelled` | Intent cancelled                              |

---

## Feature Flags Reference

| Flag                       | Default | Env Variable                | Description                                        |
|----------------------------|---------|-----------------------------|---------------------------------------------------|
| `LIVE_EXECUTION_ENABLED`   | `false` | `LIVE_EXECUTION_ENABLED`    | Master gate — no tx sent unless true              |
| `RETRY_ENABLED`            | `true`  | `RETRY_ENABLED`             | Enable automatic retry on transient errors        |
| `MULTI_WALLET_ENABLED`     | `false` | `MULTI_WALLET_ENABLED`      | Load all user wallets; select LRU                 |
| `GAS_ESCALATION_ENABLED`   | `true`  | `GAS_ESCALATION_ENABLED`    | Multiply gas 1.25× per retry                      |
| `PREWARM_ENABLED`          | `true`  | `PREWARM_ENABLED`           | Log prewarm events 30s before execute_at          |
| `RPC_HEALTH_SCORING_ENABLED`| `true` | `RPC_HEALTH_SCORING_ENABLED`| Sort RPC providers by EMA latency                 |
| `DRY_RUN_LOGGING`          | `true`  | `DRY_RUN_LOGGING`           | Log tx details even when live execution is off    |

Legacy safety flags (from original engine, still required):

| Flag                  | Env Variable            | Description                            |
|-----------------------|-------------------------|----------------------------------------|
| `AUTO_STRIKE_ENABLED` | `AUTO_STRIKE_ENABLED`   | Enables the poll loop to process intents |
| `ALPHA_VAULT_ENABLED` | `ALPHA_VAULT_ENABLED`   | Enables vault wallet decryption        |

---

## Post-Mint Handling

After a successful `sendTransaction`:

1. `mint_attempts` row inserted with `status='submitted'` and `tx_hash`
2. `mint_intents` updated: `status='success'`, `tx_hash=<hash>`, `strike_enabled=false`
3. `mint_execution_events` row inserted with phase `success`, tx hash, and latency

Transaction **confirmation** (waiting for receipt) is out of scope for the current implementation. A future `confirm` phase will poll `eth_getTransactionReceipt` and update `status` accordingly.

---

## Safety Constraints

1. **No live execution by default** — `LIVE_EXECUTION_ENABLED` defaults to `false`; must be set explicitly
2. **Double-spend prevention** — `claimIntent` uses a conditional UPDATE that only succeeds from claimable states; concurrent workers will get `null` and skip
3. **No retrying reverts** — contract execution reverts are classified as `revert` with `maxRetries=0`
4. **strike_enabled cleared on failure** — any terminal failure sets `strike_enabled=false`, preventing re-queuing
5. **Env validation at boot** — missing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or `ALPHA_VAULT_ENCRYPTION_KEY` causes the worker to boot but skip all execution
6. **Backward compatibility** — if `worker/lib/` files fail to load, the engine falls back to the original `legacyProcessIntent` code path silently
7. **Key material never logged** — private keys and encryption keys are never included in log output
