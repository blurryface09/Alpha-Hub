# UAT: Speedy Mint (Fast Path) & Auto Mint (Strike Mode)

## Scope

Two execution paths in MintGuard:

- **Fast Mint** — user's connected wallet confirms the TX. UI toggle shows "Fast". Backed by `useMint.js` → `/api/mint/prepare`.
- **Auto Mint / Strike Mode** — server-side Alpha Vault fires the TX automatically. UI toggle shows "Strike". Backed by `api/auto-mint.js` cron + `mint-engine.js`.

---

## Debug Findings (pre-UAT)

### BUG-1 · HIGH · auto-mint.js:378 — Strict `=== false` check on `automint_enabled`

```js
// CURRENT — NULL/undefined passes through and executes
if (project.automint_enabled === false) { skip }

// CORRECT
if (project.automint_enabled !== true) { skip }
```

Projects that were never explicitly armed (`automint_enabled` is NULL) will pass
this guard and execute. Any project with `mint_mode='auto'` and no vault could fire.

---

### BUG-2 · HIGH · auto-mint.js:386 — Same strict-false on `mint_time_confirmed`

```js
// CURRENT — NULL passes through
if (project.mint_time_confirmed === false) { skip }

// CORRECT
if (project.mint_time_confirmed !== true) { skip }
```

Projects with unknown mint time execute without a time gate.

---

### BUG-3 · CRITICAL · auto-mint.js:446–455 — Confirmation timeout causes double-fire

When `waitForTransactionReceipt` times out (>90 s):
1. `auto_mint_fired` is reset to `false` (line 447).
2. The project stays `status='live'`, `mint_mode='auto'`.
3. The pending tx hash is **not stored**.
4. On the next cron tick (≤60 s), the project re-enters the execution queue.
5. A second transaction is broadcast while the first may still confirm → double-spend.

Fix: store `pending_tx_hash` at submission time, check on-chain before re-executing.

---

### BUG-4 · MEDIUM · StrikeReviewModal.jsx:400 — Hardcoded "simulation-only" risk text

```
This arm is simulation-only — no real transactions will be sent until
LIVE_EXECUTION_ENABLED is enabled.
```

This text is static. After `LIVE_EXECUTION_ENABLED=true` was enabled on Vercel,
users arming live see incorrect guidance. Should read "live execution is active" when
`simResult?.live_execution_enabled === true`.

---

### BUG-5 · MEDIUM · MintGuardPage.jsx:248–255 — Telegram approval on auto-mode project uses wrong execution path

When a Telegram approval fires for a `mint_mode='auto'` project, `executeMint` is called.
That function:
1. Sets `auto_mint_fired: true` on the project.
2. Then calls `mintHook(project)` — **the wallet-confirm path**, not Alpha Vault.

Result: user needs a connected browser wallet at the moment Telegram fires, which is not
the auto-mint contract. The cron never retries because `auto_mint_fired` remains true
after the wallet fails.

---

### BUG-6 · LOW · auto-mint.js — SeaDrop contracts not handled

`auto-mint.js::findMintFn` does not include SeaDrop routing logic that `mint-engine.js`
has. OpenSea-native collections silently skip with "No supported mint function found".

---

## UAT Checklist

### Section 1 — Fast Mint (connected wallet path)

**Setup:** Project with valid contract address, correct chain, status = live.

| # | Test | Expected |
|---|------|----------|
| 1.1 | Click mint button on a `mint_mode='confirm'` project | `MintConfirmModal` opens showing project name, price, quantity |
| 1.2 | Confirm in modal; wallet is on wrong chain | "Switching network…" toast; wallet prompts chain switch; continues to TX |
| 1.3 | Confirm; wallet signs TX | "Mint submitted! TX: …" toast; project card shows `minted` badge |
| 1.4 | Confirm; user rejects in wallet | "Transaction cancelled in wallet." error — fault = `wallet` |
| 1.5 | Confirm; contract reverts | "The contract rejected the transaction…" error — fault = `collection` |
| 1.6 | Confirm; contract has non-standard function name (e.g. `purchase`) | Prepare succeeds via candidate probing; wallet prompt appears within 15 s |
| 1.7 | Confirm; project has user-set `gas_limit` override | TX submitted with that gas value, not server estimate |
| 1.8 | Mint succeeds | `mint_log` row inserted with `status='pending'`; notification inserted |
| 1.9 | Mint fails | `mint_log` row inserted with `status='failed'`; inline error shows on project card |

---

### Section 2 — Strike Review Modal

**Setup:** Pro user, Alpha Vault exists, project has contract + chain set.

| # | Test | Expected |
|---|------|----------|
| 2.1 | Toggle mode on a `mint_mode='confirm'` project (→ Strike) | `StrikeReviewModal` opens with project name in header |
| 2.2 | Checklist with vault present | Alpha Vault row = green ✓ with short address |
| 2.3 | Checklist with no vault | Alpha Vault row = red ✗, "No vault — create one in Settings"; Arm buttons disabled |
| 2.4 | Checklist with no contract address | Contract row = red ✗; Arm buttons disabled |
| 2.5 | Checklist with no mint date, status = upcoming | Timing row = amber ⚠ warning (not blocker); Arm Sim still enabled |
| 2.6 | Click "Run Simulation" with valid contract | Spinner shows; simulation result panel appears |
| 2.7 | Simulation result shows `live_execution_enabled: true` | "Arm Live" button becomes enabled; Live execution row = green |
| 2.8 | Simulation result shows `live_execution_enabled: false` | "Arm Live" button stays disabled; "Arm Sim" still available |
| 2.9 | Simulation shows contract blocker (bad address) | Blockers panel shows error; both Arm buttons disabled |
| 2.10 | Click "Arm Sim" without running simulation | Arms successfully; toast shows "simulation mode" message |
| 2.11 | Click "Arm Live" after simulation confirms live execution | Arms successfully; project card shows Strike badge; `automint_enabled=true` in DB |
| 2.12 | Risk note when `LIVE_EXECUTION_ENABLED=true` | Risk text says "live execution is active", NOT "simulation-only" ← **currently broken (BUG-4)** |
| 2.13 | Toggle Strike → Fast on an armed project | Modal does not open; project updates to `mint_mode='confirm'`, `automint_enabled=false` |

---

### Section 3 — Auto Mint Cron Execution

**Setup:** `AUTOMINT_ENABLED=true`, `LIVE_EXECUTION_ENABLED=true`, project with `mint_mode='auto'`, `automint_enabled=true`, `mint_time_confirmed=true`, valid contract, vault wallet present.

| # | Test | Expected |
|---|------|----------|
| 3.1 | Project meets all criteria | Cron fires; `execution_status` transitions: `preparing → prepared → simulating → ready → executing → submitted → confirmed` |
| 3.2 | Project has `automint_enabled = NULL` (unarmed) | **Currently executes (BUG-1)** — expected: should skip with reason `automint_not_enabled` |
| 3.3 | Project has `automint_enabled = false` | Skipped with `execution_reason='automint_not_enabled'` |
| 3.4 | Project has `mint_time_confirmed = NULL` | **Currently executes (BUG-2)** — expected: should skip with reason `mint_time_not_confirmed` |
| 3.5 | Project has no vault wallet | Skipped; Telegram notification sent: "No Alpha Vault wallet…" |
| 3.6 | Max spend limit exceeded (gas too high) | Skipped with `execution_reason='max_spend_exceeded'`; `auto_mint_fired` reset to false |
| 3.7 | TX submitted, confirmation arrives within 90 s | `status='minted'`; `execution_status='confirmed'`; `mint_log` success row; Telegram success message |
| 3.8 | TX submitted, confirmation times out (>90 s) | `execution_status='submitted'`; Telegram "TX submitted but unconfirmed" message; `auto_mint_fired` reset to false; **second execution on next tick possible (BUG-3)** |
| 3.9 | TX reverts on-chain | `execution_status='failed'`; `auto_mint_fired` reset; `mint_log` failure row; Telegram failure alert |
| 3.10 | Project with SeaDrop contract | **Currently fails (BUG-6)** — expected: SeaDrop routing used |
| 3.11 | `AUTOMINT_ENABLED=false` | Cron returns `{ dryRun: true, fired: 0 }` — no execution |
| 3.12 | Successful mint | Project `auto_mint_fired` stays `true`; status = `minted`; project no longer appears in cron query |

---

### Section 4 — Prewarm Fast Path (T=0 Speedy Mint)

**Setup:** Strike intent with `call_data` and `gas_limit` already populated by prewarm.

| # | Test | Expected |
|---|------|----------|
| 4.1 | Intent has `call_data` set | `prepareMintTransaction` NOT called at T=0; tx built from cached data in <5 ms |
| 4.2 | Intent has `call_data`, no `gas_limit` | TX submitted with `gas=undefined` (RPC estimates) |
| 4.3 | Prewarm runs on a new intent | `call_data` + `gas_limit` + `function_name` written to `mint_intents` row |
| 4.4 | Prewarm on already-cached contract | Returns immediately with `cached: true`; no prepare call |
| 4.5 | Prewarm with unsupported chain | Returns `{ ready: false, confidence: 0 }` — does not throw |
| 4.6 | T=0 timing gate — execute time 10 s in future | Intent not picked up; loop waits |
| 4.7 | T=0 timing gate — execute time 50 ms in past | Intent picked up and fires |
| 4.8 | `strike_execute_at = null` | Executes immediately (no gate) |
| 4.9 | Worst-case pickup delay with 2 s polling | ≤ 2100 ms after T=0 |
| 4.10 | End-to-end: arm → prewarm → T=0 fire with mock | Full lifecycle completes; tx shape has `to`, `data`, `value`, `gas` |

---

### Section 5 — Edge Cases & Safety

| # | Test | Expected |
|---|------|----------|
| 5.1 | Cron called without `CRON_SECRET` when env var is set | Returns 401 |
| 5.2 | Cron called with wrong secret | Returns 401 |
| 5.3 | `WALLET_ENCRYPTION_KEY` not set | Returns 200 `{ ok: false, error: 'WALLET_ENCRYPTION_KEY not configured' }` — does not crash |
| 5.4 | Supabase env vars missing | Returns 200 `{ ok: false, error: 'Supabase env vars missing' }` |
| 5.5 | No projects match query | Returns 200 `{ ok: true, fired: 0 }` |
| 5.6 | User re-arms a previously fired project (auto_mint_fired=true) | Project skipped by cron's `.neq('auto_mint_fired', true)` query |
| 5.7 | Pro paywall: non-Pro user clicks Strike | "Automint tools require Pro." toast; modal does not open |
| 5.8 | Strike armed; user disarms before cron fires | `automint_enabled=false`; cron skips on next tick (BUG-1 makes this unreliable currently) |
| 5.9 | Multiple projects for same user fire in same cron run | Each fires independently; `fired` count reflects number executed |

---

## Pass Criteria

- All Section 1 tests pass (Fast Mint golden path + error cases).
- All Section 2 tests pass, including 2.12 after BUG-4 is fixed.
- Section 3: tests 3.1, 3.3, 3.5–3.7, 3.9, 3.11, 3.12 pass. Tests 3.2, 3.4 blocked by BUG-1/BUG-2 until fixed. Test 3.8 flagged until BUG-3 is resolved.
- All Section 4 tests pass (unit-tested via `t0-flow.test.js`).
- All Section 5 safety tests pass.

---

## Bugs to Fix Before Ship

| ID | Severity | File | Fix |
|----|----------|------|-----|
| BUG-1 | HIGH | `api/auto-mint.js:378` | `=== false` → `!== true` |
| BUG-2 | HIGH | `api/auto-mint.js:386` | `=== false` → `!== true` |
| BUG-3 | CRITICAL | `api/auto-mint.js:447` | Store `pending_tx_hash` on timeout; check on-chain before re-executing |
| BUG-4 | MEDIUM | `StrikeReviewModal.jsx:400` | Conditional risk text based on `simResult?.live_execution_enabled` |
| BUG-5 | MEDIUM | `MintGuardPage.jsx:254` | Telegram-approved auto-mode projects should not call wallet mint path |
| BUG-6 | LOW | `api/auto-mint.js::findMintFn` | Add SeaDrop routing (same logic as mint-engine.js) |
