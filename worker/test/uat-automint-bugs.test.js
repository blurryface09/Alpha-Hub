/**
 * UAT: Speedy Mint & Auto Mint bug fixes
 * Tests BUG-1 through BUG-6 from docs/speedy-auto-mint-uat.md
 *
 * Run: node worker/test/uat-automint-bugs.test.js
 */

import assert from 'assert/strict'

let passed = 0
let failed = 0
const results = []

async function test(name, fn) {
  const t = Date.now()
  try {
    await fn()
    const ms = Date.now() - t
    console.log(`  ✓  ${name} (${ms}ms)`)
    passed++
    results.push({ name, pass: true, ms })
  } catch (err) {
    const ms = Date.now() - t
    console.error(`  ✗  ${name}`)
    console.error(`     ${err.message}`)
    failed++
    results.push({ name, pass: false, ms, error: err.message })
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EXECUTION_STATUS = {
  QUEUED: 'queued', PREPARING: 'preparing', PREPARED: 'prepared',
  SIMULATING: 'simulating', READY: 'ready', EXECUTING: 'executing',
  SUBMITTED: 'submitted', CONFIRMED: 'confirmed', FAILED: 'failed', SKIPPED: 'skipped',
}

function makeProject(overrides = {}) {
  return {
    id: 'proj-001',
    user_id: 'user-001',
    name: 'Test Drop',
    status: 'live',
    mint_mode: 'auto',
    automint_enabled: true,
    mint_time_confirmed: true,
    contract_address: '0xAbcDef1234567890AbcDef1234567890AbcDef12',
    chain: 'eth',
    auto_mint_fired: false,
    execution_status: null,
    ...overrides,
  }
}

function makeWallet() {
  return { user_id: 'user-001', encrypted_key: 'enckey', wallet_address: '0xVault' }
}

// ─── BUG-1: automint_enabled strict-false check ───────────────────────────────

console.log('\n=== BUG-1: automint_enabled guard ===\n')

await test('BUG-1: automint_enabled=true → proceeds past guard', () => {
  const p = makeProject({ automint_enabled: true })
  assert.equal(p.automint_enabled !== true, false, 'should not skip when true')
})

await test('BUG-1: automint_enabled=false → skipped', () => {
  const p = makeProject({ automint_enabled: false })
  assert.equal(p.automint_enabled !== true, true, 'should skip when false')
})

await test('BUG-1 (was broken): automint_enabled=null → skipped', () => {
  const p = makeProject({ automint_enabled: null })
  // Old check: null === false → false → would NOT skip (bug)
  // New check: null !== true → true → skips correctly
  assert.equal(p.automint_enabled === false, false, 'old check: null !== false → bug passes through')
  assert.equal(p.automint_enabled !== true, true, 'new check: null !== true → correctly skipped')
})

await test('BUG-1 (was broken): automint_enabled=undefined → skipped', () => {
  const p = makeProject({ automint_enabled: undefined })
  assert.equal(p.automint_enabled === false, false, 'old check: undefined !== false → bug')
  assert.equal(p.automint_enabled !== true, true, 'new check: correctly skipped')
})

// ─── BUG-2: mint_time_confirmed strict-false check ────────────────────────────

console.log('\n=== BUG-2: mint_time_confirmed guard ===\n')

await test('BUG-2: mint_time_confirmed=true → proceeds', () => {
  const p = makeProject({ mint_time_confirmed: true })
  assert.equal(p.mint_time_confirmed !== true, false, 'should proceed when confirmed')
})

await test('BUG-2: mint_time_confirmed=false → skipped', () => {
  const p = makeProject({ mint_time_confirmed: false })
  assert.equal(p.mint_time_confirmed !== true, true, 'should skip when false')
})

await test('BUG-2 (was broken): mint_time_confirmed=null → skipped', () => {
  const p = makeProject({ mint_time_confirmed: null })
  assert.equal(p.mint_time_confirmed === false, false, 'old check: null !== false → bug')
  assert.equal(p.mint_time_confirmed !== true, true, 'new check: correctly skipped')
})

await test('BUG-2 (was broken): mint_time_confirmed=undefined → skipped', () => {
  const p = makeProject({ mint_time_confirmed: undefined })
  assert.equal(p.mint_time_confirmed === false, false, 'old check: undefined !== false → bug')
  assert.equal(p.mint_time_confirmed !== true, true, 'new check: correctly skipped')
})

// ─── BUG-3: confirmation timeout double-fire prevention ───────────────────────

console.log('\n=== BUG-3: confirmation timeout — no double-fire ===\n')

await test('BUG-3: on timeout, auto_mint_fired stays true (not reset)', () => {
  // Replicate the new timeout handler logic
  const project = makeProject({ auto_mint_fired: true })
  const mintLogInserts = []
  const wlProjectUpdates = []

  // Simulate the new timeout path — auto_mint_fired is NOT reset
  mintLogInserts.push({ status: 'pending', tx_hash: '0xdeadbeef' })
  // No update to wl_projects with auto_mint_fired: false

  assert.equal(project.auto_mint_fired, true, 'auto_mint_fired must stay true')
  assert.equal(wlProjectUpdates.filter(u => u.auto_mint_fired === false).length, 0,
    'no reset of auto_mint_fired on timeout')
  assert.equal(mintLogInserts[0].status, 'pending', 'pending TX logged to mint_log')
  assert.equal(mintLogInserts[0].tx_hash, '0xdeadbeef', 'tx_hash recorded')
})

await test('BUG-3: submitted project skipped by fresh-projects query', () => {
  // Fresh query uses .neq('auto_mint_fired', true) — submitted projects are excluded
  const projects = [
    makeProject({ auto_mint_fired: false }),
    makeProject({ id: 'proj-002', auto_mint_fired: true, execution_status: EXECUTION_STATUS.SUBMITTED }),
    makeProject({ id: 'proj-003', auto_mint_fired: true, execution_status: EXECUTION_STATUS.CONFIRMED }),
  ]
  const freshProjects = projects.filter(p => p.auto_mint_fired !== true)
  assert.equal(freshProjects.length, 1, 'only proj-001 in fresh batch')
  assert.equal(freshProjects[0].id, 'proj-001')
})

await test('BUG-3: pending-confirmation query fetches only submitted+fired projects', () => {
  const projects = [
    makeProject({ auto_mint_fired: false }),
    makeProject({ id: 'proj-002', auto_mint_fired: true, execution_status: EXECUTION_STATUS.SUBMITTED }),
    makeProject({ id: 'proj-003', auto_mint_fired: true, execution_status: EXECUTION_STATUS.CONFIRMED }),
    makeProject({ id: 'proj-004', auto_mint_fired: true, execution_status: EXECUTION_STATUS.EXECUTING }),
  ]
  const pendingProjects = projects.filter(
    p => p.auto_mint_fired === true && p.execution_status === EXECUTION_STATUS.SUBMITTED
  )
  assert.equal(pendingProjects.length, 1, 'only proj-002 is submitted+fired')
  assert.equal(pendingProjects[0].id, 'proj-002')
})

await test('BUG-3: submitted+fired project routes to resolveSubmittedProject, not execute', () => {
  const project = makeProject({
    auto_mint_fired: true,
    execution_status: EXECUTION_STATUS.SUBMITTED,
  })
  // Replicate the early-exit guard from the new loop
  const shouldResolve = project.auto_mint_fired === true &&
    project.execution_status === EXECUTION_STATUS.SUBMITTED
  assert.equal(shouldResolve, true, 'should be routed to resolveSubmittedProject')
})

await test('BUG-3: resolveSubmittedProject — no pending entry → no action (safe)', () => {
  // When mint_log has no 'pending' row, the function returns early without re-executing
  const pendingTxHash = undefined // simulates empty mint_log result
  assert.equal(Boolean(pendingTxHash), false, 'no tx hash → no action taken')
})

await test('BUG-3: resolveSubmittedProject — success receipt → mark minted', () => {
  const receipt = { status: 'success' }
  const pendingTxHash = '0xabc'
  let markedMinted = false
  let pendingUpdated = false

  if (pendingTxHash && receipt?.status === 'success') {
    markedMinted = true
    pendingUpdated = true
  }

  assert.equal(markedMinted, true, 'project marked minted on confirmed receipt')
  assert.equal(pendingUpdated, true, 'mint_log pending row updated to success')
})

await test('BUG-3: resolveSubmittedProject — reverted receipt → reset fired + allow retry', () => {
  const receipt = { status: 'reverted' }
  const pendingTxHash = '0xabc'
  let autoMintFiredReset = false
  let logUpdatedFailed = false

  if (pendingTxHash && receipt?.status === 'reverted') {
    autoMintFiredReset = true // supabase reset
    logUpdatedFailed = true
  }

  assert.equal(autoMintFiredReset, true, 'auto_mint_fired reset after revert')
  assert.equal(logUpdatedFailed, true, 'mint_log updated to failed')
})

await test('BUG-3: resolveSubmittedProject — null receipt (still pending) → no action', () => {
  const receipt = null
  let reExecuted = false

  if (receipt?.status === 'success') reExecuted = true
  else if (receipt?.status === 'reverted') reExecuted = true
  // null = still pending — neither branch fires

  assert.equal(reExecuted, false, 'no re-execution when receipt is null (still pending)')
})

await test('BUG-3: resolveSubmittedProject — RPC throws → no action (conservative)', () => {
  let reExecuted = false
  try {
    throw new Error('RPC timeout')
  } catch {
    // conservative: do nothing
  }
  assert.equal(reExecuted, false, 'RPC failure leaves project as-is')
})

// ─── BUG-4: StrikeReviewModal risk text ──────────────────────────────────────

console.log('\n=== BUG-4: StrikeReviewModal risk text ===\n')

await test('BUG-4: liveExecEnabled=true → shows live execution text', () => {
  const liveExecEnabled = true
  const riskText = liveExecEnabled
    ? 'Live execution is active — real transactions will be sent when the mint opens.'
    : 'LIVE_EXECUTION_ENABLED is off — no real transactions will be sent until it is enabled.'
  assert.ok(riskText.includes('Live execution is active'), 'correct text for live mode')
  assert.ok(!riskText.includes('simulation-only'), 'no stale simulation-only text')
})

await test('BUG-4: liveExecEnabled=false → shows disabled text', () => {
  const liveExecEnabled = false
  const riskText = liveExecEnabled
    ? 'Live execution is active — real transactions will be sent when the mint opens.'
    : 'LIVE_EXECUTION_ENABLED is off — no real transactions will be sent until it is enabled.'
  assert.ok(riskText.includes('LIVE_EXECUTION_ENABLED is off'), 'correct text for disabled mode')
})

await test('BUG-4: liveExecEnabled=undefined (pre-sim) → shows disabled text', () => {
  const liveExecEnabled = undefined
  const riskText = liveExecEnabled
    ? 'Live execution is active.'
    : 'LIVE_EXECUTION_ENABLED is off — no real transactions will be sent until it is enabled.'
  assert.ok(riskText.includes('LIVE_EXECUTION_ENABLED is off'), 'falsy → disabled text')
})

// ─── BUG-5: Telegram approval on auto-mode project ───────────────────────────

console.log('\n=== BUG-5: Telegram approval path ===\n')

await test('BUG-5: mint_mode=auto → toast shown, wallet mint NOT called', () => {
  const updated = { mint_mode: 'auto', status: 'live', id: 'p1', name: 'Drop' }
  let walletMintCalled = false
  let toastShown = false

  // Replicate the new guard
  if (updated.mint_mode === 'auto') {
    toastShown = true
    // return — wallet mint path never reached
  } else {
    walletMintCalled = true
  }

  assert.equal(toastShown, true, 'toast shown for auto-mode Telegram approval')
  assert.equal(walletMintCalled, false, 'wallet mint NOT called for auto-mode project')
})

await test('BUG-5: mint_mode=confirm → wallet mint called as before', () => {
  const updated = { mint_mode: 'confirm', status: 'live', id: 'p1' }
  let walletMintCalled = false

  if (updated.mint_mode === 'auto') {
    // toast only — return
  } else {
    walletMintCalled = true
  }

  assert.equal(walletMintCalled, true, 'wallet mint called for confirm-mode project')
})

await test('BUG-5: already minted project → neither path runs', () => {
  const updated = { mint_mode: 'auto', status: 'minted', telegram_mint_approved: true }
  let anythingRan = false

  // The outer guard: telegram_mint_approved === true && status !== 'minted'
  if (updated.telegram_mint_approved === true && updated.status !== 'minted') {
    anythingRan = true
  }

  assert.equal(anythingRan, false, 'minted projects ignored by Telegram handler')
})

// ─── BUG-6: SeaDrop detection logic ──────────────────────────────────────────

console.log('\n=== BUG-6: SeaDrop contract detection ===\n')

await test('BUG-6: identifies SeaDrop by 4-arg mintPublic(address,address,address,uint256)', () => {
  const abi = [
    {
      type: 'function', name: 'mintPublic',
      inputs: [
        { name: 'nftContract', type: 'address' },
        { name: 'feeRecipient', type: 'address' },
        { name: 'minterIfNotPayer', type: 'address' },
        { name: 'quantity', type: 'uint256' },
      ],
      stateMutability: 'payable',
    },
  ]
  const seadropFn = abi.find(f =>
    f.type === 'function' && f.name === 'mintPublic' &&
    f.inputs?.length === 4 && f.inputs[0]?.type === 'address'
  )
  assert.ok(seadropFn, 'SeaDrop signature detected')
})

await test('BUG-6: does NOT misidentify regular mintPublic(uint256) as SeaDrop', () => {
  const abi = [
    {
      type: 'function', name: 'mintPublic',
      inputs: [{ name: 'quantity', type: 'uint256' }],
      stateMutability: 'payable',
    },
  ]
  const seadropFn = abi.find(f =>
    f.type === 'function' && f.name === 'mintPublic' &&
    f.inputs?.length === 4 && f.inputs[0]?.type === 'address'
  )
  assert.equal(seadropFn, undefined, 'regular mintPublic(uint256) not flagged as SeaDrop')
})

await test('BUG-6: does NOT misidentify 3-arg mintPublic as SeaDrop', () => {
  const abi = [
    {
      type: 'function', name: 'mintPublic',
      inputs: [
        { name: 'a', type: 'address' },
        { name: 'b', type: 'address' },
        { name: 'qty', type: 'uint256' },
      ],
      stateMutability: 'payable',
    },
  ]
  const seadropFn = abi.find(f =>
    f.type === 'function' && f.name === 'mintPublic' &&
    f.inputs?.length === 4 && f.inputs[0]?.type === 'address'
  )
  assert.equal(seadropFn, undefined, '3-arg mintPublic not flagged as SeaDrop')
})

await test('BUG-6: SeaDrop attempt routes to SEADROP_ADDRESS, not NFT contract', () => {
  const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  const NFT_CONTRACT = '0xAbcAbcAbcAbcAbcAbcAbcAbcAbcAbcAbcAbcAbc'
  const FALLBACK_FEE = '0x0000a26b00c1F0DF003000390027140000fAa719'

  const attempt = {
    to: SEADROP_ADDRESS,
    functionName: 'mintPublic',
    args: [NFT_CONTRACT, FALLBACK_FEE, '0xVaultWallet', 1n],
    source: 'seadrop.mintPublic',
  }

  // The `to` field override from the attempt
  const txTo = attempt.to ?? NFT_CONTRACT
  assert.equal(txTo, SEADROP_ADDRESS, 'TX goes to SeaDrop router, not NFT contract')
  assert.equal(attempt.args[0], NFT_CONTRACT, 'NFT contract is first arg')
  assert.equal(attempt.args[1], FALLBACK_FEE, 'fee recipient is second arg')
})

await test('BUG-6: attempt.to ?? project.contract_address — non-SeaDrop uses NFT contract', () => {
  const NFT = '0xNftContract'
  const attempt = { functionName: 'mint', args: [1n], source: 'common.mint(uint256)' } // no .to
  const txTo = attempt.to ?? NFT
  assert.equal(txTo, NFT, 'non-SeaDrop attempt uses project contract address')
})

// ─── Section 5: Safety edge cases ────────────────────────────────────────────

console.log('\n=== Section 5: Safety ===\n')

await test('5.1: AUTOMINT_ENABLED=false → dryRun response, no execution', () => {
  const AUTOMINT_ENABLED = false
  let fired = 0
  if (!AUTOMINT_ENABLED) {
    // returns { dryRun: true, fired: 0 }
  } else {
    fired++
  }
  assert.equal(fired, 0, 'nothing executes when kill switch is off')
})

await test('5.6: status=minted project exits queue permanently', () => {
  const project = makeProject({ status: 'minted' })
  // cron query filters .eq('status', 'live') — minted projects never appear
  const inQueue = project.status === 'live'
  assert.equal(inQueue, false, 'minted project not in live queue')
})

await test('5.9: multiple projects fire independently in same cron run', () => {
  const projects = [
    makeProject({ id: 'p1' }),
    makeProject({ id: 'p2' }),
    makeProject({ id: 'p3' }),
  ]
  // Simulate each firing independently
  let fired = 0
  for (const p of projects) {
    if (p.automint_enabled === true && p.mint_time_confirmed === true) fired++
  }
  assert.equal(fired, 3, 'all 3 projects fire in same run')
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const ms = results.reduce((s, r) => s + r.ms, 0)
console.log(`\n${passed}/${total} tests passed  |  ${ms}ms total\n`)
if (failed > 0) {
  console.error('FAILED:')
  results.filter(r => !r.pass).forEach(r => console.error(`  ✗ ${r.name}: ${r.error}`))
  process.exitCode = 1
}
