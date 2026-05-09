import { useAccount, useWriteContract, useSwitchChain } from 'wagmi'
import { parseEther, parseAbi } from 'viem'
import { mainnet, base, bsc } from 'wagmi/chains'
import toast from 'react-hot-toast'
import { supabase, getAuthToken } from '../lib/supabase'

const CHAIN_MAP = {
  eth: mainnet.id,
  base: base.id,
  bnb: bsc.id,
}

const CHAIN_IDS = { eth: 1, base: 8453, bnb: 56 }

// Try to fetch verified ABI from Etherscan
async function fetchContractAbi(contractAddress, chainKey) {
  try {
    const token = await getAuthToken()
    if (!token) return null
    const chainId = CHAIN_IDS[chainKey] || 1
    const url = new URL('/api/etherscan', window.location.origin)
    url.searchParams.set('chainid', chainId)
    url.searchParams.set('module', 'contract')
    url.searchParams.set('action', 'getabi')
    url.searchParams.set('address', contractAddress)
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json()
    if (d.status === '1' && d.result && d.result !== 'Contract source code not verified') {
      return JSON.parse(d.result)
    }
  } catch {}
  return null
}

// Pull out the best mint function from a verified ABI
function findMintFn(abi) {
  const priority = ['mint', 'publicMint', 'mintPublic', 'allowlistMint', 'presaleMint', 'purchase', 'safeMint']
  const fns = abi.filter(f => f.type === 'function' &&
    (f.stateMutability === 'payable' || f.stateMutability === 'nonpayable'))
  for (const name of priority) {
    const fn = fns.find(f => f.name === name)
    if (fn) return fn
  }
  return null
}

// Is this error a hard stop (user said no, or real on-chain revert)?
function isHardStop(e) {
  const msg = (e.shortMessage || e.message || '').toLowerCase()
  return (
    e.code === 4001 ||
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected') ||
    msg.includes('execution reverted')
  )
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
      } catch (e) {
        toast.error('Failed to switch network: ' + e.message, { id: 'mint-tx' })
        return { success: false, error: e.message }
      }
    }

    try {
      const priceStr = (project.mint_price || '0').replace(/[^0-9.]/g, '') || '0'
      const mintPrice = parseEther(priceStr)
      const quantity = BigInt(project.max_mint || 1)
      const gasLimit = BigInt(project.gas_limit || 200000)

      let txHash

      // --- Step 1: Try verified ABI from Etherscan ---
      toast.loading('Checking contract...', { id: 'mint-tx' })
      const verifiedAbi = await fetchContractAbi(project.contract_address, project.chain || 'eth')

      if (verifiedAbi) {
        const mintFn = findMintFn(verifiedAbi)
        if (mintFn) {
          toast.loading('Check your wallet to confirm...', { id: 'mint-tx' })
          // Build args: if the function takes inputs, pass quantity; otherwise no args
          const args = mintFn.inputs?.length > 0 ? [quantity] : []
          try {
            txHash = await writeContractAsync({
              address: project.contract_address,
              abi: verifiedAbi,
              functionName: mintFn.name,
              args,
              value: mintPrice * quantity,
              gas: gasLimit,
            })
          } catch (e) {
            if (isHardStop(e)) throw e
            // Verified ABI call failed for some reason — fall through to guessing
          }
        }
      }

      // --- Step 2: Fallback — try common signatures ---
      if (!txHash) {
        toast.loading('Check your wallet to confirm...', { id: 'mint-tx' })

        // Ordered by how common they are in the wild
        const attempts = [
          { sig: 'function mint(uint256 quantity) payable',          name: 'mint',           args: [quantity] },
          { sig: 'function mint(uint256 amount) payable',            name: 'mint',           args: [quantity] },
          { sig: 'function publicMint(uint256 quantity) payable',    name: 'publicMint',     args: [quantity] },
          { sig: 'function mintPublic(uint256 quantity) payable',    name: 'mintPublic',     args: [quantity] },
          { sig: 'function mint() payable',                          name: 'mint',           args: []         },
          { sig: 'function purchase(uint256 numberOfTokens) payable',name: 'purchase',       args: [quantity] },
          { sig: 'function presaleMint(uint256 quantity) payable',   name: 'presaleMint',    args: [quantity] },
          { sig: 'function allowlistMint(uint256 quantity) payable', name: 'allowlistMint',  args: [quantity] },
          { sig: 'function safeMint(address to) payable',            name: 'safeMint',       args: [address]  },
        ]

        for (const attempt of attempts) {
          try {
            txHash = await writeContractAsync({
              address: project.contract_address,
              abi: parseAbi([attempt.sig]),
              functionName: attempt.name,
              args: attempt.args,
              value: mintPrice * quantity,
              gas: gasLimit,
            })
            break // success
          } catch (e) {
            if (isHardStop(e)) throw e
            // Encoding / not-found / any other error — try next signature
            continue
          }
        }
      }

      if (!txHash) {
        throw new Error(
          'Could not find a supported mint function on this contract. ' +
          'Make sure the sale is live, or check the contract address.'
        )
      }

      // Log to mint_log
      await supabase.from('mint_log').insert({
        user_id: userId,
        project_id: project.id,
        wallet_address: address,
        chain: project.chain || 'eth',
        tx_hash: txHash,
        status: 'pending',
        executed_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {}) // non-critical, don't fail the mint

      toast.success('Mint submitted! TX: ' + txHash.slice(0, 12) + '...', { id: 'mint-tx', duration: 8000 })
      return { success: true, txHash }

    } catch (e) {
      const msg = e.shortMessage || e.message || 'Transaction failed'
      toast.error(msg.slice(0, 120), { id: 'mint-tx' })

      // Log failure (non-critical)
      if (userId) {
        supabase.from('mint_log').insert({
          user_id: userId,
          project_id: project.id,
          wallet_address: address || 'unknown',
          chain: project.chain || 'eth',
          status: 'failed',
          error_message: msg.slice(0, 200),
          executed_at: new Date().toISOString(),
        }).then(() => {}).catch(() => {})
      }
      return { success: false, error: msg }
    }
  }

  return { executeMint, isConnected, address }
}
