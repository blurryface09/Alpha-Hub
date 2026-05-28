# Roadmap

## Shipped (recent history)

| Feature | Commit | Notes |
|---------|--------|-------|
| **Private mempool submission (Base + Flashbots)** | `fe81955` | `PRIVATE_SUBMIT_ENABLED=true` → Base sequencer / Flashbots relay for FCFS intents; silent fallback |
| FCFS e2e smoke test (7 tests) | `df3091c` | Real Supabase connectivity, prewarm pipeline, 5-user concurrent FCFS, ≤1ms spread |
| Telegram boot alert (Railway worker) | `df3091c` | Fires on every worker start; `ADMIN_TELEGRAM_CHAT_ID` = personal user ID not bot ID |
| ExecutionMonitor: live countdown + prewarm badge | `df3091c` | 250ms tick, amber "prewarming" inside 30s window, Database icon when call_data ready |
| Gas strategy UI (safe / balanced / aggressive) | `df3091c` | 3-button picker in StrikeReviewModal; saved on arm; read by executor; default aggressive for FCFS |
| Prewarm urgency warning in review modal | `df3091c` | Checklist item warns if mint <5min away and call_data not precomputed |
| Admin monitor SELECT fix | `df3091c` | Removed non-existent `mint_contract_address`, added `call_data` column |
| FCFS parallel scheduler — 8/8 tests | `df3091c` | ≤1ms drift, 0ms spread across 10 concurrent intents, logger silent mode for tests |
| **🏆 MILESTONE: First production public mint via Strike** | `c7ebe18` | Base mainnet · block 46541462 · 73,061 gas · 113.7 s |
| Fix: pending treated as terminal in E2E test (BUG-11) | `c7ebe18` | Wait for `success`, not `pending` |
| Fix: Base gas fee inflation — cap priority fee to 2× baseFee (BUG-10) | `1d94f49` | No-op on Ethereum; fixes L2 over-pricing |
| Fix: stale nonce cache causes "nonce too low" (BUG-9) | `13a1dc6` | Resync `eth_getTransactionCount` at intent-start |
| Add: public mint E2E validation test suite | `6123ea3` | Deploys contract, arms intent, verifies NFT ownership |
| Fix: replace all `.catch()` on Supabase query builders | `afd05d7` | Prevent silent swallowing of DB errors |
| Fix: terminal-state guard gap in `transitionIntent` | `e9a38a1` | Prevents double-state transitions |
| Fix: live executor data field reads `calldata`/`tx_data` | `fc7f1c1` | BUG-L4 parity |
| Add: strike engine orchestration test suite (27 tests) | `31c2d07` | Full pipeline unit coverage |
| SeaDrop allowlist proof — on-chain merkle | `b270553` | Etherscan events → IPFS → local merkle |
| Fix: eligible allowlist mint + correct calldata | `a5c9953` | SeaDrop `mintAllowList` path |
| Pre-arm capability — Strike without live mint | `c4ee723` | `waiting_public_drop` allows pre-arm |
| Execution status probe layer | `fb0f7bd` | Separates display_status from probe state |
| Mint Capture Mode (5 phases) | `eb002dd` | Browser proxy + tx interception + profiles |
| Capture API merge (12-function limit fix) | `b93a6cf` | Merged capture into calendar handler |
| Fix: viem positional array for getPublicDrop | `b7a58b5` | BUG-7 — SeaDrop public mints now work |
| Fix: GitHub Actions workflow (bash -eo pipefail) | `f16f1fb` | BUG-8 — cron now fails gracefully |

---

## Phase 2 Validation (Next)

Real-user flow validation on mainnet. No direct DB insertion unless required for diagnosis.

| ID | Validation | Goal | Pass criteria |
|----|-----------|------|---------------|
| P2-1 | **Paid public mint** | `value > 0` path through Strike | Receipt confirmed, NFT minted, correct ETH deducted |
| P2-2 | **SeaDrop public mint** | SeaDrop router path end-to-end | Tx `to` = SeaDrop router, NFT minted to vault |
| P2-3 | **UI-driven Strike** | Full user flow without DB manipulation | UI arms → worker executes → receipt + ownership confirmed |

See `docs/validation-matrix.md` → Phase 2 for full test plans.

---

## Known Gaps

### SeaDrop v2

OpenSea introduced a second SeaDrop contract. Alpha Hub only supports SeaDrop v1 (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`). Collections using SeaDrop v2 will fall through to generic fallback candidates and likely fail.

**Detection**: Check on-chain if the contract implements a different SeaDrop interface.  
**Fix path**: Add `SEADROP_ADDRESS_V2` + corresponding ABI entries.

### `loadCachedExecution` never called

`contract-cache.js` exports `loadCachedExecution` which reads the Supabase `mint_contract_cache` table into the in-memory cache. It is imported but never called. The Supabase cache is written on every success but never read back.

**Effect**: Cross-instance warm-up doesn't work. Each cold-start re-runs the full candidate iteration.  
**Fix**: Call `await loadCachedExecution(contract, chain, supabase)` at the top of `prepareMintTransaction` before `getCachedExecution`.

### GitHub Actions billing

All 18 workflow runs failed due to GitHub account billing lock. The workflow code is correct — execution will work once billing is resolved.  
**Action**: Resolve at github.com/settings/billing, then trigger via Actions → Auto-Mint Cron → Run workflow.

### Capture Mode iframe blocks

Some mint sites send `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'` which the proxy cannot strip (browser enforces before the response body is even processed). For these sites, the `ManualCaptureForm` fallback is shown, requiring the user to paste raw calldata.

---

## Future Considerations

### Multi-wallet Strike

Currently Strike fires with a single Alpha Vault wallet. A future version could support multiple vault wallets per intent, allowing quantity splits across wallets.

### Onchain receipt verification

After a tx is submitted, receipt polling uses `waitForReceiptWithRecovery`. For high-gas environments, consider adding accelerate/replace (EIP-1559 fee bump) on timeout.

### SeaDrop v2 support

Required for newer OpenSea collections. The interface is different — uses ERC721SeaDrop with a different router address.

### Auto-learn quality gate

Current auto-learn saves any successful `prepare` result. A quality gate (e.g., `sample_count >= 2` before marking as `captured_ready`) would reduce false positives from one-off ABI guesses.

### Vercel Pro upgrade

12-function limit on Hobby is a hard ceiling. The capture API merge worked around it, but future API growth will require Pro. The upgrade would also unlock native per-minute Vercel crons (removing GitHub Actions dependency).
