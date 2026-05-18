/**
 * Preflight risk check tests.
 * Run: node worker/test/preflight.test.js
 */

import assert from 'assert/strict'
import { preflightCheck, preflightCheckAsync, riskLevel, RISK_LEVELS } from '../lib/preflight.js'

// ─── riskLevel ────────────────────────────────────────────────────────────────

{
  assert.equal(riskLevel(0),   RISK_LEVELS.SAFE)
  assert.equal(riskLevel(10),  RISK_LEVELS.SAFE)
  assert.equal(riskLevel(11),  RISK_LEVELS.LOW)
  assert.equal(riskLevel(25),  RISK_LEVELS.LOW)
  assert.equal(riskLevel(26),  RISK_LEVELS.MEDIUM)
  assert.equal(riskLevel(50),  RISK_LEVELS.MEDIUM)
  assert.equal(riskLevel(51),  RISK_LEVELS.HIGH)
  assert.equal(riskLevel(75),  RISK_LEVELS.HIGH)
  assert.equal(riskLevel(76),  RISK_LEVELS.CRITICAL)
  console.log('✓ riskLevel thresholds')
}

// ─── preflightCheck — healthy intent ─────────────────────────────────────────

{
  const intent = {
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_price: '0.05',
  }
  const result = preflightCheck(intent)
  assert.equal(result.safe, true)
  assert.equal(result.blockers.length, 0)
  assert.equal(result.risk_level, RISK_LEVELS.SAFE)
  console.log('✓ healthy intent passes preflight')
}

// ─── preflightCheck — missing contract ───────────────────────────────────────

{
  const result = preflightCheck({ chain: 'eth' })
  assert.equal(result.safe, false)
  assert.ok(result.blockers.some(b => b.includes('No contract address')))
  assert.ok(result.risk_score >= 50)
  console.log('✓ missing contract address is a blocker')
}

// ─── preflightCheck — zero address ───────────────────────────────────────────

{
  const result = preflightCheck({
    contract_address: '0x0000000000000000000000000000000000000000',
    chain: 'eth',
  })
  assert.equal(result.safe, false)
  assert.ok(result.blockers.some(b => b.includes('zero address')))
  console.log('✓ zero address is a blocker')
}

// ─── preflightCheck — bad address format ─────────────────────────────────────

{
  const result = preflightCheck({
    contract_address: 'not-an-address',
    chain: 'eth',
  })
  assert.equal(result.safe, false)
  assert.ok(result.blockers.some(b => b.includes('format invalid')))
  console.log('✓ invalid address format is a blocker')
}

// ─── preflightCheck — missing chain ──────────────────────────────────────────

{
  const result = preflightCheck({ contract_address: '0xabc1230000000000000000000000000000000001' })
  assert.equal(result.safe, false)
  assert.ok(result.blockers.some(b => b.includes('No chain')))
  console.log('✓ missing chain is a blocker')
}

// ─── preflightCheck — stale intent ───────────────────────────────────────────

{
  const staleDate = new Date(Date.now() - 25 * 3_600_000).toISOString()
  const result = preflightCheck({
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    strike_armed_at: staleDate,
    mint_price: '0',
  })
  assert.equal(result.safe, true) // stale is a warning, not a blocker
  assert.ok(result.warnings.some(w => w.includes('ago')))
  console.log('✓ stale intent emits warning, not blocker')
}

// ─── preflightCheck — old mint date ──────────────────────────────────────────

{
  const oldDate = new Date(Date.now() - 3 * 3_600_000).toISOString()
  const result = preflightCheck({
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_date: oldDate,
    mint_price: '0.1',
  })
  assert.ok(result.warnings.some(w => w.includes('Mint date was')))
  console.log('✓ past mint date emits warning')
}

// ─── preflightCheck — excessive spend ────────────────────────────────────────

{
  const result = preflightCheck({
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    max_total_spend: 1.5,
    mint_price: '0.1',
  })
  assert.ok(result.warnings.some(w => w.includes('high')))
  console.log('✓ excessive spend emits warning')
}

// ─── preflightCheck — missing price ──────────────────────────────────────────

{
  const result = preflightCheck({
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
  })
  assert.ok(result.warnings.some(w => w.includes('Mint price')))
  console.log('✓ missing mint price emits warning')
}

// ─── preflightCheck — explicit zero price is valid ───────────────────────────

{
  const result = preflightCheck({
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_price: '0',
  })
  assert.ok(!result.warnings.some(w => w.includes('Mint price')))
  console.log('✓ explicit zero price does not warn')
}

// ─── preflightCheckAsync — no public client ───────────────────────────────────

{
  const intent = {
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_price: '0.05',
  }
  const result = await preflightCheckAsync(intent, null)
  assert.equal(result.on_chain_checked, false)
  assert.equal(result.bytecode_present, null)
  assert.equal(result.safe, true)
  console.log('✓ preflightCheckAsync skips on-chain check without publicClient')
}

// ─── preflightCheckAsync — bytecode present ───────────────────────────────────

{
  const mockClient = {
    getBytecode: async () => '0x6080604052',
  }
  const intent = {
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_price: '0.05',
  }
  const result = await preflightCheckAsync(intent, mockClient)
  assert.equal(result.on_chain_checked, true)
  assert.equal(result.bytecode_present, true)
  assert.equal(result.safe, true)
  console.log('✓ preflightCheckAsync verifies bytecode present')
}

// ─── preflightCheckAsync — no bytecode ───────────────────────────────────────

{
  const mockClient = {
    getBytecode: async () => '0x',
  }
  const intent = {
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_price: '0.05',
  }
  const result = await preflightCheckAsync(intent, mockClient)
  assert.equal(result.on_chain_checked, true)
  assert.equal(result.bytecode_present, false)
  assert.equal(result.safe, false)
  assert.ok(result.blockers.some(b => b.includes('no deployed bytecode')))
  console.log('✓ preflightCheckAsync blocks on missing bytecode')
}

// ─── preflightCheckAsync — RPC error becomes warning ─────────────────────────

{
  const mockClient = {
    getBytecode: async () => { throw new Error('RPC down') },
  }
  const intent = {
    contract_address: '0xabc1230000000000000000000000000000000001',
    chain: 'eth',
    mint_price: '0.05',
  }
  const result = await preflightCheckAsync(intent, mockClient)
  assert.equal(result.on_chain_checked, false)
  assert.equal(result.safe, true)
  assert.ok(result.warnings.some(w => w.includes('RPC unavailable')))
  console.log('✓ preflightCheckAsync RPC error becomes warning')
}

console.log('\nAll preflight tests passed.')
