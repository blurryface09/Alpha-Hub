import { useAccount, useSwitchChain, useSendTransaction } from 'wagmi'
import { mainnet, base, bsc } from 'wagmi/chains'
import toast from 'react-hot-toast'
import { supabase, getAuthToken } from '../lib/supabase'

const CHAIN_MAP = {
  eth: mainnet.id,
  base: base.id,
  bnb: bsc.id,
}

const MINT_FUNCTIONS = ['mint', 'publicMint', 'mintPublic', 'safeMint', 'mintNFT', 'claim', 'freeMint']

function classifyMintError(message) {
  const msg = (message || '').toLowerCase()
  if (msg.includes('insufficient funds') || msg.includes('insufficient_funds')) {
    return 'Not enough ETH for mint + gas'
  }
  if (msg.includes('execution reverted') || msg.includes('reverted')) {
    return 'Contract rejected transaction. Mint may be closed or you are not eligible.'
  }
  if (msg.includes('nonce too low') || msg.includes('nonce')) {
    return 'Nonce error. Refresh and try again.'
  }
  if (msg.includes('gas') && (msg.includes('estimation failed') || msg.includes('estimate'))) {
    return 'Gas estimation failed. Try increasing gas limit manually.'
  }
  return message
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
    console.debug('[mint-benchmark] start', {
      chain: project.chain,
      contract: project.contract_address?.slice(0, 10),
      mode: project.mint_mode,
    })

    if (!isConnected || !address) {
      toast.error('Connect your wallet first')
      return { success: false, error: 'Wallet not connected' }
    }
    if (!project.contract_address) {
      toast.error('No contract address set for this project')
      return { success: false, error: 'No contract address' }
    }

    const targetChainId = CHAIN_MAP[project.chain || 'eth']
    if (!targetChainId) {
      toast.error('This chain is not supported for wallet minting yet.')
      return { success: false, error: 'Unsupported chain' }
    }

    console.debug('[mint-benchmark] chain_check', { current: chain?.id, expected: targetChainId })

    if (chain?.id !== targetChainId) {
      const tSwitch = Date.now()
      try {
        toast.loading('Switching network...', { id: 'mint-tx' })
        await switchChainAsync({ chainId: targetChainId })
        console.debug('[mint-benchmark] chain_switch_done', { duration_ms: Date.now() - tSwitch })
      } catch (e) {
        const chainName = (project.chain || 'eth').toUpperCase()
        console.debug('[mint-benchmark] chain_switch_fail', { duration_ms: Date.now() - tSwitch, error: e.message })
        toast.error(`Switch your wallet to ${chainName} network and try again`, { id: 'mint-tx' })
        return { success: false, error: e.message }
      }
    }

    try {
      toast.loading('Preparing mint before wallet opens...', { id: 'mint-tx' })
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before minting.')

      const apiParams = {
        projectId: project.id,
        wlProjectId: project.id,
        name: project.name,
        contractAddress: project.contract_address,
        chain: project.chain || 'eth',
        mintUrl: project.source_url || project.mint_url,
        mintPrice: project.mint_price || '0',
        quantity: project.max_mint || 1,
        walletAddress: address,
        mode: project.mint_mode === 'auto' ? 'strike' : 'fast',
        maxTotalSpend: project.max_total_spend,
        maxGasFee: project.max_gas_fee,
      }

      console.debug('[mint] preparing:', {
        contract: project.contract_address,
        value: project.mint_price,
        gas: project.gas_limit,
        chain: project.chain,
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
      } else {
        const firstErr = firstResult?.error || ''
        if (!isFunctionNotFound(firstErr)) {
          // Non-function-detection error -- classify and surface it immediately
          throw new Error(classifyMintError(firstErr || 'Mint preparation failed'))
        }
        // API could not detect function -- try each name explicitly
        for (const funcName of MINT_FUNCTIONS) {
          console.debug('[mint] trying function:', funcName)
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
              throw new Error(classifyMintError(errMsg || 'Mint preparation failed'))
            }
            prepared = result
            break
          } catch (e) {
            if (isFunctionNotFound(e.message)) continue
            throw e
          }
        }
        if (!prepared) {
          throw new Error('Contract mint function not found. Check contract address or try manual mint.')
        }
      }

      const tx = prepared.preparedTransaction
      console.debug('[mint-benchmark] prepared', {
        duration_ms: Date.now() - benchStart,
        fn: prepared.functionName,
        source: prepared.source,
        contract: tx.to?.slice(0, 10),
        gas: tx.gas,
        chain: tx.chainId,
      })

      toast.loading('Ready. Check your wallet to confirm.', { id: 'mint-tx' })
      const tSubmit = Date.now()
      const txHash = await sendTransactionAsync({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value || '0'),
        chainId: tx.chainId || targetChainId,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      })

      console.debug('[mint-benchmark] submitted', {
        duration_ms: Date.now() - benchStart,
        wallet_time_ms: Date.now() - tSubmit,
        txHash: txHash?.slice(0, 10),
      })

      try {
        await supabase.from('mint_log').insert({
          user_id: userId,
          project_id: project.id,
          wallet_address: address,
          chain: project.chain || 'eth',
          tx_hash: txHash,
          status: 'pending',
          executed_at: new Date().toISOString(),
        })
      } catch {}

      toast.success('Mint submitted! TX: ' + txHash.slice(0, 12) + '...', { id: 'mint-tx', duration: 8000 })
      return { success: true, txHash }

    } catch (e) {
      const msg = classifyMintError(e.shortMessage || e.message || 'Transaction failed')
      console.debug('[mint-benchmark] failed', {
        duration_ms: Date.now() - benchStart,
        failure_reason: msg.slice(0, 100),
      })
      toast.error(msg, { id: 'mint-tx', duration: 6000 })

      if (userId) {
        try {
          await supabase.from('mint_log').insert({
            user_id: userId,
            project_id: project.id,
            wallet_address: address || 'unknown',
            chain: project.chain || 'eth',
            status: 'failed',
            error_message: msg.slice(0, 200),
            executed_at: new Date().toISOString(),
          })
        } catch {}
      }
      return { success: false, error: msg }
    }
  }

  return { executeMint, isConnected, address }
}
