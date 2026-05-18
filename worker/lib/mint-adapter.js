/**
 * Fake mint contract adapter for simulation and testing.
 * Never touches the blockchain — all responses are synthetic.
 */

// ─── Adapter modes ────────────────────────────────────────────────────────────

export const ADAPTER_MODES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  CONGESTION: 'congestion',
  RANDOM: 'random',
  SEQUENCE: 'sequence',
}

// ─── Failure types (map to realistic RPC/chain errors) ───────────────────────

export const FAILURE_TYPES = {
  REVERT: 'revert',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  GAS_TOO_LOW: 'gas_too_low',
  NONCE_TOO_LOW: 'nonce_too_low',
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  DROPPED: 'dropped',
  STALE_BLOCK: 'stale_block',
  NETWORK: 'network',
}

// ─── Error builders ───────────────────────────────────────────────────────────

function buildError(type) {
  switch (type) {
    case FAILURE_TYPES.REVERT:
      return Object.assign(new Error('execution reverted: MintNotActive()'), {
        shortMessage: 'execution reverted: MintNotActive()',
      })
    case FAILURE_TYPES.INSUFFICIENT_FUNDS:
      return Object.assign(new Error('insufficient funds for gas * price + value'), {
        shortMessage: 'insufficient funds for gas * price + value',
      })
    case FAILURE_TYPES.GAS_TOO_LOW:
      return Object.assign(new Error('max fee per gas less than block base fee'), {
        shortMessage: 'max fee per gas less than block base fee',
      })
    case FAILURE_TYPES.NONCE_TOO_LOW:
      return Object.assign(new Error('nonce too low'), {
        shortMessage: 'nonce too low',
      })
    case FAILURE_TYPES.TIMEOUT:
      return Object.assign(new Error('request timed out'), {
        name: 'AbortError',
        shortMessage: 'timed out',
      })
    case FAILURE_TYPES.RATE_LIMIT:
      return Object.assign(new Error('rate limited: too many requests'), {
        shortMessage: 'rate limited',
      })
    case FAILURE_TYPES.DROPPED:
      return Object.assign(new Error('transaction dropped from mempool'), {
        shortMessage: 'transaction dropped from mempool',
      })
    case FAILURE_TYPES.STALE_BLOCK:
      return Object.assign(new Error('block is stale'), {
        shortMessage: 'block is stale',
      })
    case FAILURE_TYPES.NETWORK:
      return Object.assign(new Error('fetch failed: ECONNRESET'), {
        shortMessage: 'fetch failed',
      })
    default:
      return new Error(`Simulated failure: ${type}`)
  }
}

// ─── Deterministic fake tx hash ───────────────────────────────────────────────

function fakeTxHash(seed) {
  const n = Math.abs(Math.sin(Number(seed) || 0) * 1e18)
  return `0x${Math.floor(n).toString(16).padStart(64, '0').slice(0, 64)}`
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a mint adapter for simulation.
 *
 * @param {object} config
 * @param {string} [config.mode='success']
 * @param {string} [config.failureType='revert']
 * @param {number} [config.latencyMs=20]
 * @param {number} [config.successRate=0.8]   — used in 'random' mode
 * @param {Array<{success:boolean,failureType?:string}>} [config.sequence=[]]
 * @param {number} [config.baseFeeGwei=15]
 * @param {number} [config.chainId=1]
 * @returns {MintAdapter}
 */
export function createMintAdapter(config = {}) {
  const {
    mode = ADAPTER_MODES.SUCCESS,
    failureType = FAILURE_TYPES.REVERT,
    latencyMs = 20,
    successRate = 0.8,
    sequence = [],
    baseFeeGwei = 15,
    chainId = 1,
  } = config

  let callCount = 0
  let seqIndex = 0

  function shouldSucceed() {
    switch (mode) {
      case ADAPTER_MODES.SUCCESS: return true
      case ADAPTER_MODES.FAILURE: return false
      case ADAPTER_MODES.CONGESTION: return Math.random() > 0.5
      case ADAPTER_MODES.RANDOM: return Math.random() < successRate
      case ADAPTER_MODES.SEQUENCE: {
        const step = sequence[seqIndex % sequence.length] ?? { success: true }
        seqIndex++
        return step.success
      }
      default: return true
    }
  }

  function currentFailureType() {
    if (mode === ADAPTER_MODES.SEQUENCE) {
      const idx = (seqIndex - 1 + sequence.length) % sequence.length
      return sequence[idx]?.failureType ?? failureType
    }
    return failureType
  }

  function delay(ms = latencyMs) {
    return new Promise(r => setTimeout(r, ms))
  }

  const adapter = {
    mode,
    callCount() { return callCount },
    seqIndex() { return seqIndex },

    /** Simulate sending a transaction. Returns fake tx hash or throws. */
    async sendTransaction(_tx) {
      callCount++
      await delay()
      if (!shouldSucceed()) throw buildError(currentFailureType())
      return fakeTxHash(callCount)
    },

    /** Return a fake latest block with EIP-1559 baseFee. */
    async getBlock() {
      await delay(Math.round(latencyMs / 4))
      return {
        number: BigInt(20_000_000 + callCount),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        baseFeePerGas: BigInt(Math.round(baseFeeGwei * 1e9)),
        chainId,
      }
    },

    /** Return a fake pending nonce. */
    async getTransactionCount() {
      return callCount
    },

    /** Return a fake legacy gasPrice. */
    async getGasPrice() {
      return BigInt(Math.round(baseFeeGwei * 1.5 * 1e9))
    },

    /**
     * Build a minimal viem-compatible publicClient backed by this adapter.
     * Used for gas estimation in tests and simulations.
     */
    buildPublicClient() {
      return {
        getBlock: (opts) => adapter.getBlock(opts),
        getTransactionCount: (opts) => adapter.getTransactionCount(opts),
        getGasPrice: () => adapter.getGasPrice(),
      }
    },

    /**
     * Reset call counters — useful between test cases.
     */
    reset() {
      callCount = 0
      seqIndex = 0
    },
  }

  return adapter
}
