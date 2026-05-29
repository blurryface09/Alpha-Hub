import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { supabase, getAuthToken } from '../lib/supabase'

const ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_API_KEY

const ALCHEMY_NFT_BASE = {
  eth: `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`,
}

async function fetchNFTsForAddress(address, chain) {
  if (!ALCHEMY_KEY || !address) return []
  try {
    const url = `${ALCHEMY_NFT_BASE[chain]}/getNFTsForOwner?owner=${encodeURIComponent(address)}&withMetadata=true&pageSize=100`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const data = await res.json()
    return (data.ownedNfts || []).map(nft => {
      const contract = (nft.contract?.address || '').toLowerCase()
      const tokenId = nft.tokenId || '0'
      return {
        contract,
        tokenId,
        name: nft.name || nft.title || `#${tokenId}`,
        collection: nft.contract?.name || 'Unknown Collection',
        image: nft.image?.cachedUrl || nft.image?.thumbnailUrl || nft.image?.originalUrl || null,
        tokenType: nft.tokenType || 'ERC721',
        chain,
        owner: address.toLowerCase(),
        openseaUrl: chain === 'eth'
          ? `https://opensea.io/assets/ethereum/${contract}/${tokenId}`
          : `https://opensea.io/assets/base/${contract}/${tokenId}`,
        explorerUrl: chain === 'base'
          ? `https://basescan.org/token/${contract}`
          : `https://etherscan.io/token/${contract}`,
      }
    })
  } catch {
    return []
  }
}

/**
 * Loads portfolio data for the connected wallet + all Alpha Vault wallets.
 * - NFTs fetched from Alchemy (requires VITE_ALCHEMY_API_KEY)
 * - Vault wallets and balances fetched from /api/vault/list
 * - Mint history fetched from Supabase mint_log
 *
 * Telemetry: [vault-portfolio] logs in console
 */
export function useVaultPortfolio() {
  const { address: connectedAddress, isConnected } = useAccount()
  const [vaultWallets, setVaultWallets] = useState([])
  const [nfts, setNfts] = useState([])
  const [mintHistory, setMintHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    console.debug('[vault-portfolio] refresh start', { connectedAddress: connectedAddress?.slice(0, 10) })
    try {
      // 1. Load vault wallets (with balances)
      const token = await getAuthToken()
      let vaults = []
      if (token) {
        const r = await fetch('/api/vault/list', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const d = await r.json()
        vaults = d.wallets || []
        setVaultWallets(vaults)
        console.debug('[vault-portfolio] vaults_loaded', { count: vaults.length })
      }

      // 2. Collect all addresses to scan
      const walletTargets = []
      if (isConnected && connectedAddress) {
        walletTargets.push({ address: connectedAddress, label: 'Main Wallet', type: 'main', vaultId: null })
      }
      for (const v of vaults) {
        const addr = v.address || v.wallet_address
        if (addr) {
          walletTargets.push({ address: addr, label: v.label || 'Alpha Vault', type: 'vault', vaultId: v.id })
        }
      }

      // 3. Fetch NFTs for all wallets + both chains (parallel)
      if (ALCHEMY_KEY && walletTargets.length > 0) {
        const nftResults = await Promise.allSettled(
          walletTargets.flatMap(wallet =>
            ['eth', 'base'].map(chain =>
              fetchNFTsForAddress(wallet.address, chain).then(items =>
                items.map(nft => ({
                  ...nft,
                  walletLabel: wallet.label,
                  walletType: wallet.type,
                  vaultId: wallet.vaultId,
                }))
              )
            )
          )
        )
        const allNFTs = nftResults
          .filter(r => r.status === 'fulfilled')
          .flatMap(r => r.value)
        setNfts(allNFTs)
        console.debug('[vault-portfolio] nfts_loaded', { total: allNFTs.length, wallets: walletTargets.length })
      } else {
        setNfts([])
      }

      // 4. Fetch mint + withdrawal history from Supabase (last 30)
      const { data: history } = await supabase
        .from('mint_log')
        .select('id, user_id, wallet_address, chain, tx_hash, status, error_message, executed_at, project_id')
        .order('executed_at', { ascending: false })
        .limit(30)
      setMintHistory(history || [])
      console.debug('[vault-portfolio] history_loaded', { entries: history?.length || 0 })
    } catch (err) {
      console.error('[vault-portfolio] error', err.message)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [connectedAddress, isConnected])

  useEffect(() => {
    refresh()
  }, [refresh])

  return {
    vaultWallets,
    nfts,
    mintHistory,
    loading,
    error,
    refresh,
    hasAlchemyKey: Boolean(ALCHEMY_KEY),
  }
}
