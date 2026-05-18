/**
 * Tests for worker/lib/security.js
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  validateTransaction,
  enforceSpendCap,
  getAllowlistedContracts,
  validateContractAllowlist,
  preventDuplicateTx,
  preBroadcastSimulate,
} from '../lib/security.js'

// ─── validateTransaction ──────────────────────────────────────────────────────

describe('validateTransaction', () => {
  it('passes a well-formed EIP-1559 tx', () => {
    assert.doesNotThrow(() => validateTransaction({
      to:    '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
      value: 100n,
      data:  '0x1234',
      nonce: 5,
    }))
  })

  it('throws when to is missing', () => {
    assert.throws(
      () => validateTransaction({ value: 0n }),
      /missing to address/,
    )
  })

  it('throws for zero address', () => {
    assert.throws(
      () => validateTransaction({ to: '0x0000000000000000000000000000000000000000' }),
      /zero address/,
    )
  })

  it('throws for bad address format', () => {
    assert.throws(
      () => validateTransaction({ to: '0xnot-an-address' }),
      /format invalid/,
    )
  })

  it('throws if value is not a BigInt', () => {
    assert.throws(
      () => validateTransaction({ to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', value: 100 }),
      /BigInt/,
    )
  })

  it('throws if value is negative', () => {
    assert.throws(
      () => validateTransaction({ to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', value: -1n }),
      /negative/,
    )
  })

  it('throws if data does not start with 0x', () => {
    assert.throws(
      () => validateTransaction({ to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', data: 'deadbeef' }),
      /0x-prefixed/,
    )
  })

  it('throws for non-integer nonce', () => {
    assert.throws(
      () => validateTransaction({ to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', nonce: 1.5 }),
      /nonce is invalid/,
    )
  })

  it('throws for negative nonce', () => {
    assert.throws(
      () => validateTransaction({ to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', nonce: -1 }),
      /nonce is invalid/,
    )
  })

  it('throws when allowedChainId is a mainnet chain', () => {
    assert.throws(
      () => validateTransaction(
        { to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
        { allowedChainId: 1 },
      ),
      /mainnet/,
    )
  })

  it('throws for base mainnet chain ID 8453', () => {
    assert.throws(
      () => validateTransaction(
        { to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
        { allowedChainId: 8453 },
      ),
      /mainnet/,
    )
  })

  it('does not throw for testnet chain IDs', () => {
    assert.doesNotThrow(() => validateTransaction(
      { to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
      { allowedChainId: 11155111 },
    ))
    assert.doesNotThrow(() => validateTransaction(
      { to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
      { allowedChainId: 84532 },
    ))
  })

  it('collects multiple errors', () => {
    try {
      validateTransaction({ value: -1n, data: 'bad' })
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err.message.includes('missing to address'))
      assert.ok(err.message.includes('negative'))
      assert.ok(err.message.includes('0x-prefixed'))
    }
  })
})

// ─── enforceSpendCap ──────────────────────────────────────────────────────────

describe('enforceSpendCap', () => {
  it('throws when valueWei exceeds max_total_spend', () => {
    const intent = { max_total_spend: '0.05' }
    const overCap = BigInt(Math.round(0.06 * 1e18))
    assert.throws(
      () => enforceSpendCap(intent, overCap),
      /Spend cap exceeded/,
    )
  })

  it('passes when valueWei equals max_total_spend exactly', () => {
    const intent = { max_total_spend: '0.05' }
    const exact  = BigInt(Math.round(0.05 * 1e18))
    assert.doesNotThrow(() => enforceSpendCap(intent, exact))
  })

  it('passes when valueWei is under cap', () => {
    const intent = { max_total_spend: '0.1' }
    const under  = BigInt(Math.round(0.05 * 1e18))
    assert.doesNotThrow(() => enforceSpendCap(intent, under))
  })

  it('falls back to max_mint_price when max_total_spend is absent', () => {
    const intent = { max_mint_price: '0.02' }
    const over   = BigInt(Math.round(0.03 * 1e18))
    assert.throws(() => enforceSpendCap(intent, over), /Spend cap exceeded/)
  })

  it('no-ops when no cap is configured', () => {
    assert.doesNotThrow(() => enforceSpendCap({}, BigInt(1e18)))
  })

  it('no-ops when cap is zero', () => {
    assert.doesNotThrow(() => enforceSpendCap({ max_total_spend: '0' }, BigInt(1e18)))
  })
})

// ─── validateContractAllowlist ────────────────────────────────────────────────

describe('validateContractAllowlist', () => {
  const CONTRACT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const CONTRACT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  beforeEach(() => {
    delete process.env.CONTRACT_ALLOWLIST
  })

  it('no-ops when allowlist env var is empty', () => {
    process.env.CONTRACT_ALLOWLIST = ''
    assert.doesNotThrow(() => validateContractAllowlist(CONTRACT_A))
  })

  it('no-ops when allowlist is unset', () => {
    assert.doesNotThrow(() => validateContractAllowlist(CONTRACT_A))
  })

  it('passes for a contract in the allowlist', () => {
    process.env.CONTRACT_ALLOWLIST = CONTRACT_A
    assert.doesNotThrow(() => validateContractAllowlist(CONTRACT_A))
  })

  it('throws for a contract not in the allowlist', () => {
    process.env.CONTRACT_ALLOWLIST = CONTRACT_A
    assert.throws(
      () => validateContractAllowlist(CONTRACT_B),
      /allowlist rejection/,
    )
  })

  it('is case-insensitive', () => {
    process.env.CONTRACT_ALLOWLIST = CONTRACT_A.toUpperCase()
    assert.doesNotThrow(() => validateContractAllowlist(CONTRACT_A.toLowerCase()))
  })

  it('supports comma-separated list', () => {
    process.env.CONTRACT_ALLOWLIST = `${CONTRACT_A},${CONTRACT_B}`
    assert.doesNotThrow(() => validateContractAllowlist(CONTRACT_A))
    assert.doesNotThrow(() => validateContractAllowlist(CONTRACT_B))
  })
})

// ─── preventDuplicateTx ───────────────────────────────────────────────────────

describe('preventDuplicateTx', () => {
  function mockSupabase({ intentTxHash = null, existingAttempt = null } = {}) {
    return {
      from: (table) => ({
        select: () => ({
          eq: function() { return this },
          in: function() { return this },
          maybeSingle: async () => ({
            data: table === 'mint_intents'
              ? { id: 'intent-1', tx_hash: intentTxHash, status: 'executing_testnet' }
              : null,
          }),
          limit: function() {
            return {
              then: (resolve) => {
                const data = table === 'mint_attempts' && existingAttempt ? [existingAttempt] : []
                return Promise.resolve({ data })
              },
              catch: function() { return this },
              // make it thenable for async/await
              [Symbol.toStringTag]: 'Promise',
            }
          },
        }),
      }),
    }
  }

  function buildSupabase({ intentTxHash = null, hasAttempt = false } = {}) {
    const attemptData = hasAttempt
      ? [{ id: 'att-1', tx_hash: '0xabc', status: 'submitted' }]
      : []

    return {
      from: (table) => {
        if (table === 'mint_intents') {
          return {
            select: () => ({
              eq:          function() { return this },
              maybeSingle: async () => ({
                data: { id: 'intent-1', tx_hash: intentTxHash, status: 'executing_testnet' },
              }),
            }),
          }
        }
        // mint_attempts
        return {
          select: () => ({
            eq:    function() { return this },
            in:    function() { return this },
            limit: () => Promise.resolve({ data: attemptData }),
          }),
        }
      },
    }
  }

  it('passes when no tx_hash and no existing attempts', async () => {
    const supabase = buildSupabase()
    await assert.doesNotReject(() => preventDuplicateTx(supabase, 'intent-1'))
  })

  it('throws when intent already has a tx_hash', async () => {
    const supabase = buildSupabase({ intentTxHash: '0xdeadbeef' })
    await assert.rejects(
      () => preventDuplicateTx(supabase, 'intent-1'),
      /already has tx_hash/,
    )
  })

  it('throws when a submitted attempt exists', async () => {
    const supabase = buildSupabase({ hasAttempt: true })
    await assert.rejects(
      () => preventDuplicateTx(supabase, 'intent-1'),
      /already has a submitted attempt/,
    )
  })
})

// ─── preBroadcastSimulate ─────────────────────────────────────────────────────

describe('preBroadcastSimulate', () => {
  it('returns success=true when call succeeds', async () => {
    const mockClient = {
      call: async () => ({ data: '0x' }),
    }
    const result = await preBroadcastSimulate(mockClient, {
      to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
      data: '0x',
      value: 0n,
      from: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    })
    assert.equal(result.success, true)
    assert.equal(result.revertReason, null)
    assert.equal(result.isRevert, false)
  })

  it('returns success=false with isRevert=true on execution revert', async () => {
    const mockClient = {
      call: async () => {
        throw new Error('execution reverted: ERC20: insufficient balance')
      },
    }
    const result = await preBroadcastSimulate(mockClient, {
      to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
      data: '0x',
      value: 0n,
      from: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    })
    assert.equal(result.success, false)
    assert.equal(result.isRevert, true)
    assert.ok(result.revertReason.includes('revert'))
  })

  it('returns success=false with isRevert=false on network error', async () => {
    const mockClient = {
      call: async () => {
        throw new Error('fetch failed: connection refused')
      },
    }
    const result = await preBroadcastSimulate(mockClient, {
      to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
      data: '0x',
      value: 0n,
      from: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    })
    assert.equal(result.success, false)
    assert.equal(result.isRevert, false)
  })

  it('uses shortMessage if present', async () => {
    const mockClient = {
      call: async () => {
        const err = new Error('full error')
        err.shortMessage = 'execution reverted'
        throw err
      },
    }
    const result = await preBroadcastSimulate(mockClient, {
      to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
      data: '0x',
      value: 0n,
      from: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    })
    assert.equal(result.isRevert, true)
    assert.ok(result.revertReason.includes('reverted'))
  })
})
