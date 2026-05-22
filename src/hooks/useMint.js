import { useAccount, useSwitchChain, useSendTransaction } from 'wagmi'
import { mainnet, base, bsc, sepolia, baseSepolia } from 'wagmi/chains'
import toast from 'react-hot-toast'
import { supabase, getAuthToken } from '../lib/supabase'
import { RESTRICTION_MESSAGES, EXECUTION_BLOCKED } from '../lib/mintRestrictions.js'

const CHAIN_MAP = {
  eth: mainnet.id,
  base: base.id,
  bnb: bsc.id,
  sepolia: sepolia.id,
  'base-sepolia': baseSepolia.id,
}

const MINT_FUNCTIONS = ['mint', 'publicMint', 'mintPublic', 'safeMint', 'mintNFT', 'claim', 'freeMint']

// Returns { text, fault } — fault is 'collection' | 'wallet' | 'app'
function classifyMintError(message) {
  const msg = (message || '').toLowerCase()

  // If the server returned a known centralized restriction message, pass it through directly
  const knownRestriction = Object.values(RESTRICTION_MESSAGES).find(m => m && message === m)
  if (knownRestriction) return { text: knownRestriction, fault: 'collection' }

  // Allowlist-specific errors — must check before generic "allowlist" catch
  if (msg.includes('proof unavailable') || msg.includes('proof could not be fetched') || msg.includes('only available through the official mint page')) {
    return { text: message, fault: 'collection' }
  }
  if (msg.includes('not on the allowlist') || msg.includes('wallet not eligible') || msg.includes('not on the allowlist')) {
    return { text: message, fault: 'collection' }
  }
  if (msg.includes('allowlist phase active') || msg.includes('merkle proof required')) {
    return { text: message, fault: 'collection' }
  }

  // Collection-side: mint is closed, not active, or gated
  if (msg.includes('allowlist-only') || msg.includes('allowlist only') || msg.includes('not active for this wallet')) {
    return { text: message, fault: 'collection' }
  }
  if (msg.includes('proof required') || msg.includes('allowlist proof')) {
    return { text: message, fault: 'collection' }
  }
  if (msg.includes('not currently active') || msg.includes('not open') || msg.includes('seadrop mint not active')) {
    return { text: 'This mint is not currently open. Check the project\'s official page for the live schedule.', fault: 'collection' }
  }
  if (msg.includes('simulation failed') || msg.includes('contract rejected') || msg.includes('execution reverted') || msg.includes('reverted') || msg.includes('call_exception')) {
    return { text: 'The contract rejected the transaction. This mint may be closed, not started yet, or require an allowlist.', fault: 'collection' }
  }
  if (msg.includes('unknown mint function') || msg.includes('not found') || msg.includes('no function')) {
    return { text: 'Could not find a standard mint function on this contract. Try minting from the official site.', fault: 'collection' }
  }
  if (msg.includes('no contract exists')) {
    return { text: 'No contract found at this address on the selected chain. Check the contract address in your project settings.', fault: 'collection' }
  }

  // Wallet-side: user action or funds
  if (msg.includes('insufficient funds') || msg.includes('insufficient_funds')) {
    return { text: 'Not enough ETH in your wallet for this mint + gas fees.', fault: 'wallet' }
  }
  if (msg.includes('user rejected') || msg.includes('user denied') || msg.includes('cancelled')) {
    return { text: 'Transaction cancelled in wallet.', fault: 'wallet' }
  }
  if (msg.includes('nonce')) {
    return { text: 'Nonce conflict — refresh the page and try again.', fault: 'wallet' }
  }

  // App/infra-side: our connectivity or chain issues
  if (msg.includes('rpc') || msg.includes('connection failed') || msg.includes('timeout') || msg.includes('timed out')) {
    return { text: 'Connection error. Please retry in a moment.', fault: 'app' }
  }
  if (msg.includes('gas estimation failed') || msg.includes('could not estimate')) {
    return { text: 'Gas estimation failed. Try setting a manual gas limit in Edit.', fault: 'app' }
  }

  return { text: message || 'Mint failed. Please try again.', fault: 'app' }
}

function isFunctionNotFound(msg) {
  return /function not found|unknown function|no function|cannot find|not found in abi/i.test(msg || '')
}

export function useMint() {
  const { address, isConnected, chain } = useAccount()
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()

  const executeMint = async (project, userId) => {
    const benchStart = Date.now()
    const chain_ = project.chain || 'eth'

    console.debug('[mint-exec] start', {
      chain: chain_,
      contract: project.contract_address?.slice(0, 10),
      mode: project.mint_mode,
    })

    if (!isConnected || !address) {
      console.debug('[mint-exec] error', { stage: 'wallet_check', reason: 'not_connected' })
      toast.error('Connect your wallet first')
      return { success: false, error: 'Wallet not connected' }
    }
    if (!project.contract_address) {
      console.debug('[mint-exec] error', { stage: 'wallet_check', reason: 'no_contract' })
      toast.error('No contract address set for this project')
      return { success: false, error: 'No contract address' }
    }

    const targetChainId = CHAIN_MAP[chain_]
    if (!targetChainId) {
      console.debug('[mint-exec] error', { stage: 'chain_check', reason: 'unsupported_chain', chain: chain_ })
      toast.error('This chain is not supported for wallet minting yet.')
      return { success: false, error: 'Unsupported chain' }
    }

    console.debug('[mint-exec] wallet_check', { address: address.slice(0, 10), current: chain?.id, expected: targetChainId })

    if (chain?.id !== targetChainId) {
      const tSwitch = Date.now()
      console.debug('[mint-exec] chain_switch_start', { from: chain?.id, to: targetChainId })
      try {
        toast.loading('Switching network...', { id: 'mint-tx' })
        await switchChainAsync({ chainId: targetChainId })
        console.debug('[mint-exec] chain_switch_ok', { duration_ms: Date.now() - tSwitch, chainId: targetChainId })
      } catch (e) {
        const chainName = chain_.toUpperCase()
        console.debug('[mint-exec] error', { stage: 'chain_switch', reason: e.message, duration_ms: Date.now() - tSwitch })
        toast.error(`Switch your wallet to ${chainName} network and try again`, { id: 'mint-tx' })
        return { success: false, error: e.message }
      }
    }

    try {
      toast.loading('Preparing mint before wallet opens...', { id: 'mint-tx' })

      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before minting.')
      console.debug('[mint-exec] auth_ok')

      // 'auto' mode means Strike (server-side Alpha Vault execution); anything else is a normal
      // wallet-confirm mint. Send 'safe' so the intent record reflects the actual execution path.
      const executionMode = project.mint_mode === 'auto' ? 'strike' : 'safe'

      const apiParams = {
        projectId: project.id,
        wlProjectId: project.id,
        name: project.name,
        contractAddress: project.contract_address,
        chain: chain_,
        mintUrl: project.source_url || project.mint_url,
        mintPrice: project.mint_price || '0',
        quantity: project.max_mint || 1,
        walletAddress: address,
        mode: executionMode,
        maxTotalSpend: project.max_total_spend,
        maxGasFee: project.max_gas_fee,
      }

      console.debug('[mint-exec] prepare_start', {
        contract: project.contract_address?.slice(0, 10),
        chain: chain_,
        mode: executionMode,
        gasOverride: project.gas_limit || null,
      })

      // First attempt without a specific function name (API may auto-detect)
      let prepared = null
      let firstResponse, firstResult
      try {
        firstResponse = await fetch('/api/mint/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(apiParams),
          signal: AbortSignal.timeout(15000),
        })
        firstResult = await firstResponse.json().catch(() => ({}))
      } catch (fetchErr) {
        throw new Error(fetchErr.message || 'Mint prepare request failed')
      }

      if (firstResponse.ok && firstResult?.preparedTransaction && firstResult?.ok !== false) {
        prepared = firstResult
        console.debug('[mint-exec] prepare_ok', {
          fn: prepared.functionName,
          source: prepared.source,
          gas: prepared.preparedTransaction?.gas,
          cacheHit: prepared.preparedTransaction?.cacheHit,
          optimized: prepared.optimized,
          duration_ms: Date.now() - benchStart,
        })
      } else {
        const firstErr = firstResult?.error || ''
        const serverReason = firstResult?.reason || ''
        if (!isFunctionNotFound(firstErr)) {
          // Non-function-detection error — surface immediately with context
          const classified = classifyMintError(firstErr || 'Mint preparation failed')
          console.debug('[mint-exec] error', { stage: 'prepare', reason: firstErr, serverReason, fault: classified.fault, httpStatus: firstResponse.status })
          throw Object.assign(new Error(classified.text), { fault: classified.fault })
        }
        // API could not detect function — probe each candidate name explicitly
        for (const funcName of MINT_FUNCTIONS) {
          console.debug('[mint-exec] candidate_probe', { fn: funcName })
          try {
            const res = await fetch('/api/mint/prepare', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ ...apiParams, functionName: funcName }),
              signal: AbortSignal.timeout(10000),
            })
            const result = await res.json().catch(() => ({}))
            if (!res.ok || result?.ok === false || !result?.preparedTransaction) {
              const errMsg = result?.error || ''
              if (isFunctionNotFound(errMsg)) continue
              const classified = classifyMintError(errMsg || 'Mint preparation failed')
              console.debug('[mint-exec] error', { stage: 'candidate_probe', fn: funcName, reason: errMsg, serverReason: result?.reason || '', fault: classified.fault })
              throw Object.assign(new Error(classified.text), { fault: classified.fault })
            }
            prepared = result
            console.debug('[mint-exec] candidate_ok', { fn: funcName, duration_ms: Date.now() - benchStart })
            break
          } catch (e) {
            if (isFunctionNotFound(e.message)) continue
            throw e
          }
        }
        if (!prepared) {
          console.debug('[mint-exec] error', { stage: 'candidate_probe', reason: 'all_candidates_failed' })
          throw new Error('Contract mint function not found. Check contract address or try manual mint.')
        }
      }

      const tx = prepared.preparedTransaction

      // gas_limit from MintConfirmModal user override takes priority over server estimate
      const gasToUse = project.gas_limit
        ? BigInt(project.gas_limit)
        : tx.gas ? BigInt(tx.gas) : undefined

      console.debug('[mint-exec] tx_submit', {
        contract: tx.to?.slice(0, 10),
        gas: gasToUse?.toString(),
        gasSource: project.gas_limit ? 'user_override' : 'server_estimate',
        value: tx.value,
        chainId: tx.chainId || targetChainId,
        duration_ms: Date.now() - benchStart,
      })

      toast.loading(
        prepared.optimized
          ? 'Optimized route ready. Check your wallet to confirm.'
          : 'Ready. Check your wallet to confirm.',
        { id: 'mint-tx' },
      )
      const tSubmit = Date.now()
      const txHash = await sendTransactionAsync({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value || '0'),
        chainId: tx.chainId || targetChainId,
        gas: gasToUse,
      })

      console.debug('[mint-exec] tx_ok', {
        txHash: txHash?.slice(0, 10),
        duration_ms: Date.now() - benchStart,
        wallet_time_ms: Date.now() - tSubmit,
      })

      try {
        await supabase.from('mint_log').insert({
          user_id: userId,
          project_id: project.id,
          wallet_address: address,
          chain: chain_,
          tx_hash: txHash,
          status: 'pending',
          executed_at: new Date().toISOString(),
        })
      } catch {}

      toast.success('Mint submitted! TX: ' + txHash.slice(0, 12) + '...', { id: 'mint-tx', duration: 8000 })
      return { success: true, txHash }

    } catch (e) {
      const classified = e.fault
        ? { text: e.message, fault: e.fault }
        : classifyMintError(e.shortMessage || e.message || 'Transaction failed')
      const { text: msg, fault } = classified
      console.debug('[mint-exec] error', {
        stage: 'execution',
        reason: msg.slice(0, 120),
        fault,
        duration_ms: Date.now() - benchStart,
      })
      toast.error(msg, { id: 'mint-tx', duration: fault === 'collection' ? 10000 : 6000 })

      if (userId) {
        try {
          await supabase.from('mint_log').insert({
            user_id: userId,
            project_id: project.id,
            wallet_address: address || 'unknown',
            chain: chain_,
            status: 'failed',
            error_message: msg.slice(0, 200),
            executed_at: new Date().toISOString(),
          })
        } catch {}
      }
      return { success: false, error: msg, fault }
    }
  }

  return { executeMint, isConnected, address }
}
