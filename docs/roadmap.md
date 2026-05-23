# Roadmap

## Shipped (recent history)

| Feature | Commit | Notes |
|---------|--------|-------|
| SeaDrop allowlist proof — on-chain merkle | `b270553` | Etherscan events → IPFS → local merkle |
| Fix: eligible allowlist mint + correct calldata | `a5c9953` | SeaDrop `mintAllowList` path |
| Pre-arm capability — Strike without live mint | `c4ee723` | `waiting_public_drop` allows pre-arm |
| Execution status probe layer | `fb0f7bd` | Separates display_status from probe state |
| Mint Capture Mode (5 phases) | `eb002dd` | Browser proxy + tx interception + profiles |
| Capture API merge (12-function limit fix) | `b93a6cf` | Merged capture into calendar handler |
| Fix: viem positional array for getPublicDrop | `b7a58b5` | BUG-7 — SeaDrop public mints now work |
| Fix: GitHub Actions workflow (bash -eo pipefail) | `f16f1fb` | BUG-8 — cron now fails gracefully |

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
