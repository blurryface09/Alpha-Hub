# Alpha Hub — System Architecture

## Components

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (React/Vite SPA)                                   │
│  src/components/mint/   src/lib/   src/pages/               │
└────────────��─────────────┬──────────────────────────────────┘
                           │ HTTPS
┌──────��───────────────────▼──────────────────────────────────┐
│  Vercel Serverless Functions  (12-function Hobby limit)     │
│                                                             │
│  api/calendar/[action].js   ← mint, vault, capture actions │
│  api/auto-mint.js           ← server-side cron execution   │
│  api/etherscan.js           ← price + AI analysis          │
│  api/metadata.js            ← project intake / detection   │
│  api/status.js              ← system health                │
│  api/subscription.js        ← billing                      │
│  api/telegram.js            ← Telegram bot commands        │
│  api/wallet.js              ← vault operations             │
│  api/whale-poll.js          ← on-chain whale activity      │
│  api/cron-notify.js         ← daily Vercel cron            │
│  api/admin-subscriptions.js ← admin payment tools         │
│  api/payments/[action].js   ← payment hooks               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  api/_lib/  (shared library, NOT deployed as functions)     │
│                                                             │
│  mint-engine.js          ← prepareMintTransaction + Strike │
│  execution-optimizer.js  ← gas profiles + RPC ordering     │
│  contract-cache.js       ← in-memory ABI + exec cache      │
│  vault-engine.js         ← wallet create/decrypt/withdraw  │
│  rpc.js                  ← multi-RPC fallback transport    │
│  auth.js                 ← Supabase JWT validation         │
│  project-intelligence.js ← chain/phase normalization       │
��  readiness.js            ← readiness probe helpers         │
│  redis.js                ← Upstash Redis client            │
│  pricing.js              ← fee/price utilities             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Supabase (PostgreSQL + Auth + Realtime)                    │
│                                                             │
│  wl_projects             ← project registry + status       │
│  mint_intents            ← Strike arming + execution state │
│  mint_attempts           ← per-attempt tx records          │
│  mint_execution_events   ← structured execution log        │
│  mint_contract_cache     ← persistent exec profiles (DB)   │
│  alpha_vault_wallets     ← AES-256-GCM encrypted keys      │
│  mint_capture_profiles   ← learned execution profiles      │
│  profiles                ← user accounts                   │
│  minting_wallets         ← legacy wallet table             │
│  mint_log                ← wallet mints + vault withdrawals│
└────��────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  GitHub Actions Cron (every minute)                         │
│  .github/workflows/auto-mint-cron.yml                      │
│  → POST /api/auto-mint   (Strike auto-fire loop)           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Railway Worker  (worker/strike-engine.js)                  │
│  Long-running process: polls mint_intents every 15s        │
│  Handles prewarm, gas estimation, tx dispatch              │
└─────────────────────────────────────────────────────────────┘
```

## Request Flow — Mint Prepare

```
Browser → POST /api/mint/prepare
       → vercel.json rewrite → /api/calendar/mint-prepare
       → api/calendar/[action].js  (action = 'prepare')
       → handleMintAction(req, res, 'prepare')
       → prepareMintTransaction(body)
       → buildSeaDropCandidates() or candidatesFromAbi() or fallbackCandidates()
       → estimateGas() on each candidate
       → returns { to, data, value, gas, functionName, ... }
```

## Request Flow — Strike Arm

```
Browser → POST /api/mint/enable-strike
       → handleMintAction(req, res, 'enable-strike')
       → loadCaptureProfile()  (check learned profiles first)
       → prepareMintTransaction({ walletAddress: vault.address })
       → upsert mint_intents  (status: 'armed', strike_execute_at: T)
       → returns { ok, intent_id, simulation: { ... } }
```

## Deployment

- **Frontend**: Vercel (Vite build → dist/)
- **API**: Vercel Serverless (Node 20, max 12 functions on Hobby)
- **Worker**: Railway (persistent process)
- **DB**: Supabase (hosted PostgreSQL)
- **Cache**: Upstash Redis (optional, for rate limiting)
- **Cron**: GitHub Actions (per-minute) + Vercel native (daily)

## Environment Variables (Required)

| Variable | Used By | Purpose |
|----------|---------|---------|
| `VITE_SUPABASE_URL` | frontend + api | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | api | Service role for server ops |
| `WALLET_ENCRYPTION_KEY` | api/auto-mint + worker | AES-256 master key |
| `ETH_RPC_URL` | mint-engine | Ethereum RPC |
| `BASE_RPC_URL` | mint-engine | Base RPC |
| `ETHERSCAN_API_KEY` | mint-engine + metadata | ABI + event logs |
| `LIVE_EXECUTION_ENABLED` | mint-engine | Safety kill switch |
| `CRON_SECRET` | auto-mint + cron-notify | Auth for cron endpoints |
| `APP_URL` | GitHub Actions workflow | Vercel deployment URL |

See also: `docs/cron-setup.md` for external cron configuration.
