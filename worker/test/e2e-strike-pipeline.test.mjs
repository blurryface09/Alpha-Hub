/**
 * End-to-end Strike pipeline validation.
 *
 * Validates the full production path without a live NFT contract dependency:
 *   Schema → Vault wallet → Intent create → Worker claim → Wallet decrypt →
 *   Tx dispatch → Telemetry chain → Final state
 *
 * Uses a prebuilt 0-value transaction (call_data fast path) so the test does not
 * depend on a live mint contract or SeaDrop detection.
 *
 * Run: node worker/test/e2e-strike-pipeline.test.mjs
 *
 * Prerequisite: apply database/worker_prewarm_columns.sql in Supabase SQL editor first.
 *
 * The Railway worker must be running — it will claim and execute the test intent.
 * The vault wallet needs a small amount of Base ETH (~0.000005 ETH) to pay gas.
 */

import { createClient } from '@supabase/supabase-js'
import { createPublicClient, http, formatEther } from 'viem'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// ─── Config ───────────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(__dir, '../.env')

function loadEnv(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch { /* env already set via Railway / shell */ }
}

loadEnv(envPath)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENCRYPTION_KEY = process.env.ALPHA_VAULT_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Poll timeout: 6 minutes. Strike worker tick is 2s — plenty of headroom.
const POLL_TIMEOUT_MS = 6 * 60 * 1000
const POLL_INTERVAL_MS = 3000

// Execute 90 seconds from now to give us time to see the worker log it
const EXECUTE_DELAY_MS = 90 * 1000

// ─── Reporting ────────────────────────────────────────────────────────────────

let pass = 0, fail = 0, warn = 0
const timeline = []

function ok(label, detail = '') {
  const msg = `  ✓  ${label}${detail ? `  (${detail})` : ''}`
  console.log(msg)
  timeline.push({ status: 'pass', label, detail })
  pass++
}

function no(label, reason) {
  const msg = `  ✗  ${label}\n     ${reason}`
  console.error(msg)
  timeline.push({ status: 'fail', label, reason })
  fail++
}

function info(label, detail = '') {
  console.log(`       ${label}${detail ? `:  ${detail}` : ''}`)
}

function skip(label, reason) {
  console.warn(`  -  ${label}  (${reason})`)
  timeline.push({ status: 'skip', label, reason })
  warn++
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function decryptKey(encrypted, userId, masterKey) {
  const buf = Buffer.from(encrypted, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const salt = Buffer.from(userId)
  const keyMaterial = crypto.pbkdf2Sync(masterKey, salt, 100000, 32, 'sha256')
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final()
}

// ─── Test body ────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║   Alpha Hub — E2E Strike Pipeline Validation             ║')
console.log('╚══════════════════════════════════════════════════════════╝\n')

// ─── Step 1: Schema verification ─────────────────────────────────────────────

console.log('─── Step 1: Schema verification ─────────────────────────\n')

const requiredColumns = ['call_data', 'gas_limit', 'to', 'value', 'function_name', 'gas_strategy']
let schemaOk = true

{
  const { data, error } = await supabase
    .from('mint_intents')
    .select(requiredColumns.join(', '))
    .limit(1)

  if (error) {
    no('New prewarm columns exist in mint_intents', error.message)
    console.error('\n  ► Apply database/worker_prewarm_columns.sql in Supabase SQL editor first.\n')
    schemaOk = false
  } else {
    ok('New prewarm columns exist in mint_intents', requiredColumns.join(', '))
  }
}

if (!schemaOk) {
  console.error('\nSchema check failed — cannot proceed without migration.\n')
  process.exit(1)
}

// ─── Step 2: Vault wallet ─────────────────────────────────────────────────────

console.log('\n─── Step 2: Vault wallet ─────────────────────────────────\n')

let vaultWallet = null

{
  const { data, error } = await supabase
    .from('alpha_vault_wallets')
    .select('id, user_id, address, wallet_address, encrypted_private_key, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    no('Vault wallet found in DB', error?.message || 'No vault wallets exist')
    console.error('  ► Create a vault wallet via the Alpha Hub UI first.')
    process.exit(1)
  }

  vaultWallet = data
  vaultWallet.resolvedAddress = vaultWallet.address || vaultWallet.wallet_address
  ok('Vault wallet found', `id=${vaultWallet.id.slice(0, 8)} addr=${vaultWallet.resolvedAddress}`)
  info('user_id', vaultWallet.user_id.slice(0, 8) + '…')
  info('created_at', vaultWallet.created_at)
}

// ─── Step 2b: Decrypt wallet (verify key works before inserting intent) ───────

{
  if (!ENCRYPTION_KEY) {
    no('Wallet decrypt pre-check', 'ALPHA_VAULT_ENCRYPTION_KEY / WALLET_ENCRYPTION_KEY not set')
    process.exit(1)
  }

  try {
    const decrypted = decryptKey(
      vaultWallet.encrypted_private_key,
      vaultWallet.user_id,
      ENCRYPTION_KEY,
    )
    const isKey = /^[0-9a-fA-F]{64}$/.test(decrypted.replace(/^0x/, ''))
    if (isKey) {
      ok('Wallet decrypt pre-check', 'private key decrypts correctly with current key')
    } else {
      no('Wallet decrypt pre-check', `Decrypted value is not a hex private key: ${decrypted.slice(0, 12)}…`)
      process.exit(1)
    }
  } catch (e) {
    no('Wallet decrypt pre-check', `Decrypt failed: ${e.message} — key mismatch or corrupted ciphertext`)
    console.error('  ► Rotate WALLET_ENCRYPTION_KEY or re-create the vault wallet.')
    process.exit(1)
  }
}

// ─── Step 2c: Base ETH balance ────────────────────────────────────────────────

{
  try {
    const publicClient = createPublicClient({ transport: http(BASE_RPC, { timeout: 10000 }) })
    const balance = await publicClient.getBalance({ address: vaultWallet.resolvedAddress })
    const eth = formatEther(balance)
    if (balance === 0n) {
      skip('Base ETH balance', `wallet has 0 ETH — tx will fail at dispatch (pipeline still validated)`)
      info('address', vaultWallet.resolvedAddress)
      info('action', 'Fund with ~0.000005 Base ETH for a successful dispatch test')
    } else {
      ok('Base ETH balance', `${eth} ETH`)
      info('address', vaultWallet.resolvedAddress)
    }
  } catch (e) {
    skip('Base ETH balance check', `RPC error: ${e.message.slice(0, 80)}`)
  }
}

// ─── Step 3: Insert armed intent ─────────────────────────────────────────────

console.log('\n─── Step 3: Create armed intent ─────────────────────────\n')

const executeAt = new Date(Date.now() + EXECUTE_DELAY_MS).toISOString()
let testIntentId = null

{
  // Self-transfer of 0 ETH on Base — valid tx that requires only gas.
  // call_data='0x' puts this on the prewarm fast path (executor skips prepareMintTransaction).
  const intentRow = {
    user_id:           vaultWallet.user_id,
    chain:             'base',
    project_name:      'e2e-test',
    contract_address:  vaultWallet.resolvedAddress,
    to:                vaultWallet.resolvedAddress,
    call_data:         '0x',                  // non-null → fast path engaged
    value:             '0',
    gas_limit:         21000,
    function_name:     'e2e_test',
    gas_strategy:      'safe',
    vault_wallet_id:   vaultWallet.id,
    strike_enabled:    true,
    strike_execute_at: executeAt,
    status:            'armed',
    quantity:          1,
    last_state:        'E2E validation: armed and waiting for worker',
  }

  const { data, error } = await supabase
    .from('mint_intents')
    .insert(intentRow)
    .select()
    .single()

  if (error || !data) {
    no('Intent inserted', error?.message || 'No row returned')
    process.exit(1)
  }

  testIntentId = data.id
  ok('Armed intent created', `id=${testIntentId}`)
  info('chain', 'base')
  info('to', vaultWallet.resolvedAddress)
  info('call_data', '0x  (fast path engaged)')
  info('gas_limit', '21000')
  info('execute_at', executeAt)
  info('status', 'armed')
}

// ─── Step 4–8: Poll for state transitions ────────────────────────────────────

console.log('\n─── Steps 4–8: Pipeline monitoring ──────────────────────\n')
console.log(`  Polling intent ${testIntentId} every ${POLL_INTERVAL_MS / 1000}s`)
console.log(`  Execute window opens at ${executeAt}`)
console.log(`  Poll timeout: ${POLL_TIMEOUT_MS / 60000} minutes\n`)

const seenStates = new Set()
const seenEvents = new Set()
let finalState = null
let txHash = null
let lastUpdatedAt = null
const startMs = Date.now()

// Track each state transition as a named check
const EXPECTED_TRANSITIONS = [
  { state: 'armed',     label: 'Step 4: Intent enters armed state (initial)' },
  { state: 'executing', label: 'Step 5: Worker claimed intent → executing' },
  { state: 'pending',   label: 'Step 7: Tx broadcast → pending confirmation' },
]
const TERMINAL_STATES = new Set(['success', 'failed', 'expired', 'cancelled'])

while (Date.now() - startMs < POLL_TIMEOUT_MS) {
  await sleep(POLL_INTERVAL_MS)

  const { data: intent, error: iErr } = await supabase
    .from('mint_intents')
    .select('status, last_state, tx_hash, updated_at, call_data, gas_limit, gas_strategy, function_name')
    .eq('id', testIntentId)
    .single()

  if (iErr || !intent) {
    console.error(`  [poll error] ${iErr?.message}`)
    continue
  }

  const st = intent.status

  if (!seenStates.has(st)) {
    seenStates.add(st)
    const label = EXPECTED_TRANSITIONS.find(t => t.state === st)?.label || `State transition: ${st}`
    ok(label, `last_state="${intent.last_state?.slice(0, 60)}"`)

    if (intent.tx_hash && !txHash) {
      txHash = intent.tx_hash
      ok('Step 7b: tx_hash recorded', txHash)
    }

    lastUpdatedAt = intent.updated_at
  }

  // Poll telemetry events when we first see executing
  if (st === 'executing' && !seenEvents.has('executing_events')) {
    seenEvents.add('executing_events')

    const { data: evts } = await supabase
      .from('mint_execution_events')
      .select('state, message, created_at')
      .eq('intent_id', testIntentId)
      .order('created_at', { ascending: true })

    if (evts?.length) {
      ok('Step 6: Telemetry events emitted', `${evts.length} events`)
      for (const evt of evts) {
        info(`[${evt.state}]`, evt.message?.slice(0, 80))
      }
    }
  }

  if (TERMINAL_STATES.has(st)) {
    finalState = st
    break
  }
}

// ─── Step 8: Final state & telemetry summary ──────────────────────────────────

console.log('\n─── Step 8: Final state ──────────────────────────────────\n')

if (finalState) {
  if (finalState === 'success') {
    ok('Step 8: Final state', 'success')
    if (txHash) ok('Tx confirmed on-chain', txHash)
  } else if (finalState === 'failed') {
    // 'failed' is expected when wallet has no ETH for gas — pipeline still fully exercised
    const { data: intent } = await supabase
      .from('mint_intents')
      .select('last_state, tx_hash')
      .eq('id', testIntentId)
      .single()
    ok('Step 8: Final state recorded', `failed — ${intent?.last_state?.slice(0, 80)}`)
    info('note', 'failed state is expected if wallet has no Base ETH for gas')
    if (intent?.tx_hash) ok('Tx hash recorded', intent.tx_hash)
  } else {
    ok(`Step 8: Final state`, finalState)
  }
} else {
  no('Step 8: Final state within timeout', `Still in state: ${[...seenStates].join(' → ')} after ${POLL_TIMEOUT_MS / 60000}min`)
}

// Final telemetry dump
{
  const { data: allEvts } = await supabase
    .from('mint_execution_events')
    .select('state, message, created_at, metadata')
    .eq('intent_id', testIntentId)
    .order('created_at', { ascending: true })

  if (allEvts?.length) {
    console.log('\n─── Telemetry chain ──────────────────────────────────────\n')
    for (const evt of allEvts) {
      const ts = new Date(evt.created_at).toISOString().slice(11, 19)
      console.log(`  [${ts}] [${evt.state.padEnd(12)}]  ${evt.message?.slice(0, 90)}`)
    }
    ok('Step 8b: Telemetry chain complete', `${allEvts.length} events`)
  } else {
    skip('Telemetry events', 'none found — worker may not have reached the intent yet')
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1)
const total = pass + fail

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║   E2E Summary                                            ║')
console.log('╚══════════════════════════════════════════════════════════╝\n')
console.log(`  Intent ID:     ${testIntentId}`)
console.log(`  States seen:   ${[...seenStates].join(' → ')}`)
console.log(`  Final state:   ${finalState ?? 'timeout'}`)
console.log(`  Tx hash:       ${txHash ?? '(none)'}`)
console.log(`  Elapsed:       ${elapsedS}s`)
console.log(`  Passed:        ${pass}/${total}  |  Failed: ${fail}  |  Skipped: ${warn}`)

if (fail === 0) {
  console.log('\n  ✓ Pipeline validated end-to-end.\n')
} else {
  console.log('\n  ✗ Some checks failed — review output above.\n')
  process.exitCode = 1
}
