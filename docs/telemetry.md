# Telemetry Reference

All structured logs are emitted via `console.log()` and appear in Vercel runtime logs.  
Format: `console.log('[namespace] event_name', { ...fields })`

---

## Namespaces

### `[mint-benchmark]`

Emitted by `prepareMintTransaction`.

| Event | When | Fields |
|-------|------|--------|
| `cache_hit` | Fast path used | `fn, successCount, contract, chain` |
| `cache_stale` | Cached fn failed gas estimate | `fn, contract, chain` |
| `cache_fast_path_fail` | Fast path error (non-gas) | `error, chain` |
| `seadrop_detected` | SeaDrop path active | `nftContract, feeRecipient, mintPrice, startTime, endTime, nowTs, isActive, hasAllowlist, feeRecipientCount` |
| `seadrop_setup_fail` | buildSeaDropCandidates threw | `error` |
| `seadrop_blind_detected` | Unverified contract is SeaDrop | `contract, chain` |
| `seadrop_blind_miss` | Blind probe failed | `contract, chain` |
| `candidates` | Candidate list assembled | `chain, contract, protocolCount, abiCount, fallbackCount, total, hint, rpc` |
| `candidate_fail` | Gas estimate failed for candidate | `chain, contract, fn, source, error` |
| `success` | Winning candidate found | `duration_ms, chain, contract, fn, source, gas, attempts, rpc` |

### `[mint-path-trace]`

Emitted once on successful `prepareMintTransaction`.

```json
{
  "contract": "0x1234...",
  "chain": "eth",
  "abi_source": "etherscan_verified | none",
  "candidates_tried": 2,
  "all_fns_tried": ["mintPublic", "mint"],
  "selected_fn": "mintPublic",
  "selected_args": ["0x00005EA...", "0x0000a2...", "0x0000...0000", "1"],
  "msg_value": "1000000000000000",
  "calldata": "0x6871ee40000...",
  "router_target": "0x00005EA... | direct",
  "gas_estimate": "185432",
  "source": "seadrop",
  "outcome": "success"
}
```

### `[capability-check]`

Emitted by `probeCapability` during Strike arm simulation.

```json
{
  "contract": "0x1234...",
  "chain": "eth",
  "seadrop": true,
  "confirmed": true,
  "startTime": "1700000000",
  "endTime": "0",
  "feeRecipientCount": 1,
  "isActive": true
}
```

### `[allowlist-proof]`

Emitted by `fetchSeaDropAllowlistProof`.

| Event | Fields |
|-------|--------|
| Proof found | `wallet, contract, phase='allowlist', proof_found=true, function='mintAllowList', source, proofLen` |
| API unavailable | `wallet, contract, phase, proof_found=false, failure_reason='api_unavailable'` |
| Wallet ineligible | `wallet, contract, phase, proof_found=false, failure_reason='probe_error'` |
| Signed mint | `wallet, contract, phase='signed_mint', proof_found=false, failure_reason='signed_mint_no_public_api'` |

### `[strike-prep]`

Emitted during `enable-strike` arm flow (stages).

| Stage | Meaning |
|-------|---------|
| `prepare_ok` | Gas estimate succeeded with vault wallet |
| `live_low_balance` | Gas OK but vault may be underfunded |
| `proof_unavailable` | Allowlist, proof API down |
| `wallet_not_eligible` | Not on allowlist |
| `allowlist_ready` | Allowlist phase, stub wallet used |
| `capability_probe` | Fallback probe ran | + `prepared_status, fn, details` |
| `capability_probe_error` | Probe threw | + `err` |
| `sim_capture_profile` | Capture profile promoted to captured_ready | + `protocol, fn` |

### `[mint-live-probe]`

Emitted by the auto-mint background polling loop.

---

## Execution Trace Checklist

To reconstruct the full execution path for a contract, find these logs in order:

```
1. [capability-check]       ← readiness probe result
2. [mint-benchmark] seadrop_detected  ← if SeaDrop
3. [mint-benchmark] candidates        ← candidate list
4. [mint-benchmark] candidate_fail    ← per-failed candidate (0..N)
5. [mint-benchmark] success           ← winning candidate
6. [mint-path-trace]                  ← exact tx parameters
7. [strike-prep]                      ← arm result
```

If `[mint-path-trace]` is absent, execution failed. The last `[mint-benchmark] candidate_fail` holds the root cause error.

---

## Vercel Log Filtering

In the Vercel Dashboard (Functions → Logs tab):

- Filter by function: `calendar` for mint/strike ops
- Search: paste contract address first 10 chars (e.g. `0x1234abcd`)
- Search: `seadrop_detected` to find all SeaDrop probe results
- Search: `isActive.*false` to find all "not active" failures
- Search: `outcome.*success` to find successful executions only

For structured log export (Pro plan): configure a log drain to your observability platform.
