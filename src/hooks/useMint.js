import { useAccount, useSwitchChain, useSendTransaction } from 'wagmi'
import { mainnet, base, bsc } from 'wagmi/chains'
import toast from 'react-hot-toast'
import { supabase, getAuthToken } from '../lib/supabase'
import { friendlyError } from '../lib/errors'

const CHAIN_MAP = {
  eth: mainnet.id,
  base: base.id,
  bnb: bsc.id,
}

export function useMint() {
  const { address, isConnected, chain } = useAccount()
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()

  const executeMint = async (project, userId) => {
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

    // Switch chain if needed
    if (chain?.id !== targetChainId) {
      try {
        toast.loading('Switching network...', { id: 'mint-tx' })
        await switchChainAsync({ chainId: targetChainId })
      } catch (e) {
        toast.error(friendlyError(e, 'Could not switch network. Please try again.'), { id: 'mint-tx' })
        return { success: false, error: e.message }
      }
    }

    try {
      toast.loading('Preparing mint before wallet opens...', { id: 'mint-tx' })
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before minting.')
      const response = await fetch('/api/mint/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
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
        }),
        signal: AbortSignal.timeout(15000),
      })
      const prepared = await response.json().catch(() => ({}))
      if (!response.ok || prepared?.ok === false || !prepared?.preparedTransaction) {
        throw new Error(prepared?.error || 'Needs contract or mint function before wallet can open.')
      }

      const tx = prepared.preparedTransaction
      toast.loading('Ready. Check your wallet to confirm.', { id: 'mint-tx' })
      const txHash = await sendTransactionAsync({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value || '0'),
        chainId: tx.chainId || targetChainId,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      })

      // Log to mint_log; non-critical, don't fail a submitted mint.
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
      const msg = e.shortMessage || e.message || 'Transaction failed'
      toast.error(friendlyError(e, 'Mint transaction failed. Please check the project and try again.'), { id: 'mint-tx' })

      // Log failure (non-critical)
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
