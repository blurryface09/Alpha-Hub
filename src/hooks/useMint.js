import { useAccount, useWriteContract, useSwitchChain } from 'wagmi'
import { parseEther, parseAbi } from 'viem'
import { mainnet, base, bsc } from 'wagmi/chains'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'

const CHAIN_MAP = {
  eth: mainnet.id,
  base: base.id,
  bnb: bsc.id,
}

export function useMint() {
  const { address, isConnected, chain } = useAccount()
  const { writeContractAsync } = useWriteContract()
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

    // Switch chain if needed
    if (chain?.id !== targetChainId) {
      try {
        toast.loading('Switching network...', { id: 'mint-tx' })
        await switchChainAsync({ chainId: targetChainId })
      } catch(e) {
        toast.error('Failed to switch network: ' + e.message, { id: 'mint-tx' })
        return { success: false, error: e.message }
      }
    }

    try {
      toast.loading('Check your wallet to confirm...', { id: 'mint-tx' })

      const mintAbi = parseAbi([
        'function mint(uint256 quantity) payable',
        'function publicMint(uint256 quantity) payable',
        'function safeMint(address to) payable',
        'function mintPublic(uint256 quantity) payable',
      ])

      const priceStr = (project.mint_price || '0').replace(/[^0-9.]/g, '') || '0'
      const mintPrice = parseEther(priceStr)
      const quantity = BigInt(project.max_mint || 1)

      let txHash
      const mintFunctions = ['mint', 'publicMint', 'mintPublic']

      for (const funcName of mintFunctions) {
        try {
          txHash = await writeContractAsync({
            address: project.contract_address,
            abi: mintAbi,
            functionName: funcName,
            args: [quantity],
            value: mintPrice * quantity,
            gas: BigInt(project.gas_limit || 200000),
          })
          break
        } catch(e) {
          if (e.message?.includes('does not exist') || e.message?.includes('not found')) {
            continue
          }
          throw e
        }
      }

      if (!txHash) throw new Error('Could not find mint function on contract')

      toast.loading('Waiting for confirmation...', { id: 'mint-tx' })

      await supabase.from('mint_log').insert({
        user_id: userId,
        project_id: project.id,
        wallet_address: address,
        chain: project.chain || 'eth',
        tx_hash: txHash,
        status: 'pending',
        executed_at: new Date().toISOString(),
      })

      toast.success('Mint submitted! TX: ' + txHash.slice(0,12) + '...', { id: 'mint-tx', duration: 8000 })
      return { success: true, txHash }

    } catch(e) {
      const msg = e.shortMessage || e.message || 'Transaction failed'
      toast.error(msg.slice(0, 100), { id: 'mint-tx' })
      if (userId) {
        await supabase.from('mint_log').insert({
          user_id: userId,
          project_id: project.id,
          wallet_address: address || 'unknown',
          chain: project.chain || 'eth',
          status: 'failed',
          error_message: msg.slice(0, 200),
          executed_at: new Date().toISOString(),
        })
      }
      return { success: false, error: msg }
    }
  }

  return { executeMint, isConnected, address }
}
