# Alpha Hub — On-Chain Intelligence Platform

Multi-chain wallet tracker, mint assistant, whale radar and rug detector.

## Stack
- React + Vite + Tailwind
- Supabase (database + auth + realtime)
- Alchemy (blockchain data)
- Etherscan V2 API
- wagmi + WalletConnect (wallet connection)
- Gemini AI (forensic analysis)

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Required keys:
- `VITE_SUPABASE_URL` — your Supabase project URL ✅ (already set)
- `VITE_SUPABASE_ANON_KEY` — your Supabase anon key ✅ (already set)
- `VITE_ALCHEMY_API_KEY` — from alchemy.com (free)
- `VITE_WALLETCONNECT_PROJECT_ID` — from cloud.walletconnect.com (free)
- `VITE_ETHERSCAN_API_KEY` — from etherscan.io/apis (free)
- `VITE_GEMINI_API_KEY` — from aistudio.google.com (free)

### 3. Run the database schema
Go to Supabase → SQL Editor → paste the schema from `src/lib/supabase.js` → Run ✅ (already done)

### 4. Run locally
```bash
npm run dev
```

### 5. Deploy to Vercel
```bash
npm run build
```
Then drag the `dist` folder to vercel.com, or connect your GitHub repo.

**Important:** Add all your `.env` variables to Vercel's Environment Variables settings before deploying.

## Features

### MintGuard
- Track WL projects by pasting Twitter/OpenSea/website URLs
- AI auto-extracts project metadata
- Set GTD or FCFS WL type with mint date and price
- Countdown timers for upcoming mints
- Per-project mint mode: Confirm (asks you) or Auto (fires immediately)
- One-click mint execution via connected wallet
- Full mint log with transaction hashes

### WhaleRadar
- Add any wallet address to your watchlist
- Polls every 30 seconds for new transactions
- Detects mint transactions automatically
- AI summarises each whale move in plain English
- Real-time activity feed with Supabase realtime
- In-app notifications for every whale move

### Alpha Tools
- Full wallet forensic analysis
- Jeet score 0-100 with evidence
- Failed transaction decoder (explains what went wrong)
- Internal transaction tracking
- Smart contract security audit
- AI reads actual source code for backdoors
- Works on Ethereum and Base

## Architecture

```
Frontend (React/Vite) → Vercel
Database (Supabase) → Central EU
Blockchain data → Alchemy + Etherscan V2
AI Analysis → Gemini 2.0 Flash
Wallet signing → MetaMask via wagmi
```
