# Alpha Hub — Claude Knowledge Base

This file is the living memory for Claude sessions. Read it before touching any code.  
Last updated: 2026-05-28

---

## What This Project Is

Alpha Hub is a full-stack NFT mint execution platform. Users arm "strike intents" — a Railway-hosted worker picks them up and broadcasts signed transactions at the exact millisecond the mint opens.

**Three separate runtimes:**
- **Vercel** — Next.js-style API routes (`api/`) + React front-end (`src/`)
- **Railway** — Long-running Node.js worker (`worker/strike-engine.js`)
- **Supabase** — Postgres DB + auth (RLS in place; worker uses service role key)

---

## Key Architecture Decisions

### Intent State Machine (always respect this)

```
pending → armed → executing → success / failed
                ↘ retrying ↗
```

Valid transitions in `worker/lib/queue.js::VALID_TRANSITIONS`. Do not invent new transitions.

`armed → executing` IS valid (it's what `claimIntent` does). The state machine doc was wrong; it was corrected in tests. `armed → retrying` is NOT valid directly.

### FCFS Precision Scheduler

`worker/lib/scheduler.js` — registers `setTimeout` timers at exact `strike_execute_at` ms. All intents with the same `execute_at` fire simultaneously via `Promise.allSettled`. Tested at 0–1ms spread for 10 concurrent intents. Test: `worker/test/fcfs-parallel.test.js` (8/8).

### Prewarm Pipeline (real write-back, not just logging)

`worker/lib/prewarmer.js::prewarmIntent` runs at T-30s. It calls `prepareMintTransaction`, then writes `call_data` + `gas_limit` + `function_name` back to `mint_intents` in Supabase. At T=0 the executor reads `intent.call_data` and skips all detection — **zero RPC calls for detection**, straight to broadcast.

If `call_data` is still null at T=0 (prewarm window too short), the executor runs inline detection (11 mint function candidates) before falling back to `prepareMintTransaction`.

### Gas Strategies (user-selectable on arm)

`gas_strategy` stored on `mint_intents`. Three levels:
- `safe` — baseFee×1.5 + 1 gwei tip
- `balanced` — baseFee×2.0 + 1.5 gwei tip (default for live-detection)
- `aggressive` — baseFee×2.5 + 3 gwei tip (default for FCFS/timed)

The `StrikeReviewModal` shows a three-button picker. Default auto-selects based on whether `mint_date` is set.

### Private Mempool Submission (FCFS only)

`worker/lib/private-submit.js` — activated by `PRIVATE_SUBMIT_ENABLED=true` in Railway env.

Only fires for intents with `strike_execute_at` set (FCFS). Routes `eth_sendRawTransaction` to:
- **Base** → `mainnet-sequencer.base.org` (or `BASE_SEQUENCER_URL` override) — bypasses public p2p gossip
- **Ethereum** → `rpc.flashbots.net` with `eth_sendPrivateTransaction` — off public mempool

Optional Flashbots auth: set `FLASHBOTS_AUTH_KEY` (any Ethereum private key) to get MEV-Share reputation. Without it, the call still works. Silently falls back to public RPC on any failure (5s timeout per private attempt). Logs `private_ok` / `private_fallback` in Railway.

All non-broadcast RPC calls (eth_chainId, eth_getTransactionCount, etc.) pass through unchanged.

### Telegram Alerts

Two kinds:
1. **Boot alert** — `worker/strike-engine.js` — fires on every worker start. Uses `TELEGRAM_BOT_TOKEN` + `ADMIN_TELEGRAM_CHAT_ID` (personal user chat ID, NOT bot ID). Both must be in Railway worker env vars.
2. **Mint success** — `executor.js` — fires after tx confirmed. Uses `profiles.telegram_chat_id` (per-user, stored in Supabase).

**Critical**: `ADMIN_TELEGRAM_CHAT_ID` is the USER's personal Telegram ID, not the bot's ID. Get it from @userinfobot. The user's ID is `7737024288` (username: @poseidros).

---

## Environment Variables

### Vercel (api/ functions)
```
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
ETHERSCAN_API_KEY, GROQ_API_KEY, ALCHEMY_API_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
WALLET_ENCRYPTION_KEY
VITE_ADMIN_WALLET, VITE_RECEIVER_WALLET
TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
CRON_SECRET
```

### Railway (worker service)
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
WALLET_ENCRYPTION_KEY
TELEGRAM_BOT_TOKEN         ← must be here too, separate from Vercel
ADMIN_TELEGRAM_CHAT_ID     ← personal user Telegram ID (not bot ID)
LIVE_EXECUTION_ENABLED=true
AUTO_STRIKE_ENABLED=true
ALPHA_VAULT_ENABLED=true
PRIVATE_SUBMIT_ENABLED     ← set "true" to enable private mempool
BASE_SEQUENCER_URL         ← defaults to https://mainnet-sequencer.base.org
FLASHBOTS_AUTH_KEY         ← optional, Ethereum private key for MEV-Share auth
BASE_RPC_URL, BASE_RPC_URL_FALLBACK_1
ETH_RPC_URL, ETH_RPC_URL_FALLBACK_1
```

---

## File Map (critical paths)

| File | Purpose |
|------|---------|
| `worker/strike-engine.js` | Main poll loop, boot alert, FCFS scheduler |
| `worker/lib/executor.js` | Full intent lifecycle (claim → build → send → confirm) |
| `worker/lib/private-submit.js` | Private mempool transport (Base sequencer / Flashbots) |
| `worker/lib/prewarmer.js` | T-30s prewarm — writes call_data to DB |
| `worker/lib/scheduler.js` | FCFS precision setTimeout scheduler |
| `worker/lib/rpc.js` | EMA-scored RPC failover + viem transport |
| `worker/lib/gas.js` | Gas strategy computation (safe/balanced/aggressive) |
| `worker/lib/flags.js` | All feature flags — `flagEnabled()` checks here first |
| `worker/lib/queue.js` | State machine, `claimIntent`, `fetchReadyIntents` |
| `worker/lib/wallet.js` | AES-256-GCM vault key decrypt → viem account |
| `worker/lib/retry.js` | `withRetry`, error classifier, nonce tracker |
| `worker/lib/timing.js` | `isReadyToExecute`, `isInPrewarmWindow`, `msUntilExecute` |
| `api/_lib/mint-engine.js` | `prepareMintTransaction` — detects mint function from ABI |
| `api/_lib/contract-cache.js` | In-memory + Supabase cache for detected mint functions |
| `api/admin/[action].js` | Admin endpoints (monitor, arm, etc.) — note brackets in filename |
| `src/pages/ExecutionMonitorPage.jsx` | Live intent dashboard with countdown + prewarm badge |
| `src/components/mint/StrikeReviewModal.jsx` | Arm confirmation modal (gas picker, checklist) |
| `src/pages/MintGuardPage.jsx` | Main guard/arm page |

---

## Test Suite (always run `npm test` before committing)

```
node worker/test/uat-automint-bugs.test.js      # 33 tests — automint bug regressions
node worker/test/preflight.test.js              # 15 tests — preflight checks
node worker/test/gas.test.js                    # 17 tests — gas strategy math
node worker/test/rpc.test.js                    # 16 tests — RPC failover
node worker/test/queue.test.js                  # 13 tests — state machine
node worker/test/strike-engine.test.js          # 27 tests — orchestration matrix
NODE_ENV=test node worker/test/fcfs-parallel.test.js  # 8 tests — FCFS scheduler
NODE_ENV=test node worker/test/e2e-smoke.test.js      # 7 tests — e2e pipeline
```

Total: **136 tests, 0 failing** (as of 2026-05-28).

`NODE_ENV=test` suppresses info/debug logs (only errors/warns shown). Required for FCFS/e2e tests to avoid timing noise.

---

## Common Gotchas

### git add with brackets in filename
```bash
git add 'api/admin/[action].js'   # quotes required — brackets are shell globs
```

### `flagEnabled()` unknown flag returns false + warns
Any new feature flag MUST be added to `FLAGS` in `worker/lib/flags.js` or `flagEnabled('MY_FLAG')` silently returns `false`.

### Execution Monitor SELECT must not include `mint_contract_address`
That column doesn't exist on `mint_intents`. The correct column is `contract_address`. The SELECT in `api/admin/[action].js` was fixed to exclude it and add `call_data`.

### `TELEGRAM_BOT_TOKEN` must be in Railway env, not just Vercel
It's needed in both places for different purposes. Telegram boot alert only works if the Railway worker service has both `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_CHAT_ID`.

### Supabase mock `then()` pattern
When mocking Supabase in tests, the `.update({...}).eq().then(r, onErr)` pattern calls `then()` with two args. The mock must apply patches in `then()`, not return rows.

### viem `custom` transport and `eth_fillTransaction`
The non-standard `eth_fillTransaction` method times out on all public RPCs. Intercept and throw immediately in any custom transport: `throw Object.assign(new Error('not supported'), { code: -32601 })`.

### Flashbots `eth_sendPrivateTransaction` params
Method: `eth_sendPrivateTransaction`, params: `[{ tx: "0x..." }]` (object wrapper, not raw string).

---

## FCFS Competitiveness Assessment

Current state (2026-05-28):

| Layer | What we have | Gap vs top bots |
|-------|-------------|-----------------|
| Timing | ≤1ms drift via setTimeout FCFS scheduler | ~equal |
| Prewarm | call_data precomputed at T-30s | ~equal |
| Gas | 3 strategies incl. aggressive (baseFee×2.5) | slight gap (bots do dynamic) |
| Submission | Private endpoints (Base sequencer / Flashbots) | ~equal after this PR |
| RPC | EMA-scored failover, env-configurable URLs | slight gap (bots use private/dedicated nodes) |
| Wallet | Single vault wallet | gap (bots fan out across many wallets) |
| Simulation | Pre-arm; not at T=0 | ~equal |

**Honest verdict**: Competitive for most public FCFS mints. Not competitive against top MEV bots with dedicated infrastructure (colocation, private nodes, multi-wallet fan-out). But comparable to sophisticated retail competitors using Flashbots/Alchemy.

---

## Recent Changes (2026-05-28 session)

1. **FCFS load test** — 8/8 passing; fixed wall-time threshold (`< WORK_MS*2 + 200`) and removed stray `results` reference
2. **Logger silent mode** — `LOG_SILENT=1` or `NODE_ENV=test` suppresses info/debug in tests
3. **queue.test** — fixed stale `armed → retrying` assertion (should be `armed → executing`)
4. **e2e smoke test** — 7 tests: real Supabase connectivity, prewarm pipeline, scheduler, 5-user FCFS
5. **Gas strategy UI** — `StrikeReviewModal` gas picker (safe/balanced/aggressive); saved on arm, read by executor
6. **Prewarm warning** — checklist item in review modal warns if mint <5min away and call_data not ready
7. **ExecutionMonitor countdown** — 250ms tick countdown, amber "prewarming" inside 30s window, green "FIRING" at T=0
8. **Prewarm badge** — Database icon appears on IntentRow when `intent.call_data` is set
9. **Admin monitor SELECT fix** — removed non-existent `mint_contract_address`, added `call_data`
10. **Telegram boot alert** — fires on Railway worker start; debug: check both env vars in Railway, use personal chat ID not bot ID
11. **Private mempool submission** — `worker/lib/private-submit.js`; Base sequencer + Flashbots; activate with `PRIVATE_SUBMIT_ENABLED=true`
