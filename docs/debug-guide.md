# How to Debug Mint Failures

A step-by-step guide for diagnosing execution failures in Alpha Hub.

---

## Step 1 — Identify the failure surface

| Symptom | Where to look |
|---------|--------------|
| Strike arm button stays disabled | `StrikeReviewModal` blockers array — check simulation response |
| Capability badge shows wrong state | `probeCapability` result — check `[capability-check]` log |
| "cannot mint" for a contract in PUBLIC stage | `buildSeaDropCandidates` — check `[mint-benchmark] seadrop_detected` log |
| Gas estimate fails | `[mint-benchmark] candidate_fail` — look for revert reason |
| Strike fires but tx fails | `mint_attempts` table — check `error_message` column |
| Workflow runs but no mints | `wl_projects` — check `automint_enabled`, `mint_time_confirmed`, `status='live'` |
| GitHub cron dies in 3-4 seconds | `steps: []` in GitHub Actions — billing issue |

---

## Step 2 — Find the Vercel logs

1. Go to Vercel Dashboard → Project → Functions tab
2. Filter by function: `api/calendar/[action]` for most mint ops
3. Search for the contract address (first 10 chars) or intent ID

Key log namespaces to search:
```
[mint-benchmark]     ← execution path trace
[mint-path-trace]    ← success trace with full calldata
[capability-check]   ← readiness probe result
[allowlist-proof]    ← allowlist proof fetch
[strike-prep]        ← arm simulation stages
```

---

## Step 3 — Trace a SeaDrop failure

**Scenario**: Public mint is live on OpenSea but Alpha Hub shows "Waiting Drop" or "Official Mint".

### Check `[mint-benchmark] seadrop_detected`

```json
{
  "nftContract": "0x1234abcd...",
  "mintPrice": "0",          ← BUG: should be non-zero
  "startTime": "0",          ← BUG: viem positional array issue
  "endTime": "0",            ← BUG: viem positional array issue
  "isActive": false,         ← WRONG: should be true
  "feeRecipientCount": 1
}
```

If `startTime: "0"` and mint is confirmed live on-chain → **BUG-7 variant** or `getPublicDrop` is reverting.

To verify on-chain state directly:
```bash
# Call getPublicDrop on SeaDrop v1 for the NFT contract
cast call 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5 \
  "getPublicDrop(address)(uint80,uint48,uint48,uint16,uint16,bool)" \
  <NFT_CONTRACT_ADDRESS> \
  --rpc-url $ETH_RPC_URL
# Returns: mintPrice, startTime, endTime, maxMintable, feeBps, restrictFeeRecipients
```

### Check `[capability-check]`

```json
{
  "seadrop": true,
  "confirmed": true,
  "startTime": "1700000000",
  "endTime": "0",
  "isActive": true
}
```

If `isActive: true` here but prepare still fails → the issue is in gas estimation, not the capability probe.

---

## Step 4 — Trace a gas estimation failure

### Check `[mint-benchmark] candidate_fail` (repeated)

```json
{
  "fn": "mintPublic",
  "source": "seadrop",
  "error": "IncorrectPayment(0, 1000000000000000)"
}
```

Common revert reasons:

| Revert | Cause | Fix |
|--------|-------|-----|
| `IncorrectPayment(sent, required)` | Wrong `msg.value` | Check `mintPrice * quantity` calculation |
| `FeeRecipientNotAllowed` | Wrong fee recipient | Verify `getAllowedFeeRecipients` returns non-empty |
| `NotActive` | Drop not active by contract's clock | Check on-chain `startTime`/`endTime` vs block.timestamp |
| `MintQuantityExceedsMaxMintedPerWallet` | Over limit | Reduce quantity |
| `TransactionExpired` | Nonce issue (in worker) | Worker will retry with fresh nonce |

### Check `[mint-path-trace]` (only present on success)

If this log exists, execution succeeded. The returned `to`, `data`, `value` are the exact transaction parameters sent to the wallet/worker.

---

## Step 5 — Check the intent state

Query `mint_intents` directly:

```sql
SELECT id, status, prepared_execution_status, strike_execute_at,
       strike_error, tx_hash, prepared_tx
FROM mint_intents
WHERE user_id = '<user_id>'
ORDER BY created_at DESC
LIMIT 5;
```

| Status | Next action |
|--------|-------------|
| `armed` | Will execute at `strike_execute_at` |
| `executing` | Currently running (or stuck — check `updated_at`) |
| `minted` | Done — check `tx_hash` |
| `failed` | Check `strike_error` — use strike-rerun to retry |
| `draft` | Not armed — user needs to complete arm flow |

Stuck `executing` (no update in > 5 minutes): use `strike-rerun` to reset to `armed`.

---

## Step 6 — Check the auto-mint queue

```sql
SELECT id, name, status, mint_mode, automint_enabled,
       mint_time_confirmed, auto_mint_fired, execution_status
FROM wl_projects
WHERE mint_mode = 'auto' AND status = 'live'
ORDER BY updated_at DESC;
```

A project will NOT be picked up by auto-mint if:
- `automint_enabled != true` (must be strict true)
- `mint_time_confirmed != true` (must be strict true)
- `auto_mint_fired = true` (already fired — check `execution_status`)
- `status != 'live'`
- `contract_address IS NULL`

---

## Step 7 — Invalidate stale caches

The execution cache is in-memory (cleared on cold start). Probe cache is 15 minutes. To force a fresh probe:

1. Wait 15 minutes (probe TTL), or
2. Trigger a fresh `POST /api/mint/readiness` for the contract — this resets the probe cache result
3. For persistent Supabase exec cache: delete the row from `mint_contract_cache` where `contract_address = '<addr>'`

---

## Common False Positive: "Not Started" from capture profile

If a project shows `captured_ready` but the mint isn't live yet, this is expected — the capture profile was saved from a previous execution simulation. Strike will fire at `strike_execute_at` using the cached calldata. If the contract state has changed (e.g., price change, mint paused), the tx may fail at execution time.

Always re-run `strike-simulate` before arming if there's been a significant time gap since the profile was captured.
