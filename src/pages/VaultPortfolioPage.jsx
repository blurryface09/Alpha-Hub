import React, { useState } from 'react'
import { parseEther, formatEther } from 'viem'
import { motion } from 'framer-motion'
import {
  Wallet, RefreshCw, ExternalLink, Database, ArrowUpRight,
  Clock, CheckCircle, XCircle, Send, AlertTriangle, ImageOff,
} from 'lucide-react'
import { useAccount } from 'wagmi'
import toast from 'react-hot-toast'
import { getAuthToken } from '../lib/supabase'
import { useVaultPortfolio } from '../hooks/useVaultPortfolio'

const TABS = ['All Assets', 'Main Wallet', 'Alpha Vault']

// ─── helpers ─────────────────────────────────────────────────────────────────

function shortAddr(addr) {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function explorerTxUrl(chain, txHash) {
  if (!txHash) return null
  if (chain === 'base') return `https://basescan.org/tx/${txHash}`
  if (chain === 'bnb') return `https://bscscan.com/tx/${txHash}`
  return `https://etherscan.io/tx/${txHash}`
}

function explorerAddressUrl(chain, address) {
  if (!address) return null
  if (chain === 'base') return `https://basescan.org/address/${address}`
  return `https://etherscan.io/address/${address}`
}

// ─── sub-components ──────────────────────────────────────────────────────────

function NFTCard({ nft, canWithdraw, onWithdraw }) {
  const [imgError, setImgError] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-surface2 overflow-hidden hover:border-accent/30 transition-colors">
      {/* Image */}
      <div className="aspect-square bg-surface relative">
        {nft.image && !imgError ? (
          <img
            src={nft.image}
            alt={nft.name}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted">
            <ImageOff size={22} className="opacity-30" />
          </div>
        )}
        {/* Chain badge */}
        <span className={`absolute top-1.5 left-1.5 text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold ${
          nft.chain === 'base'
            ? 'bg-blue-500/80 text-white'
            : 'bg-black/60 text-muted border border-border/60'
        }`}>
          {nft.chain.toUpperCase()}
        </span>
        {/* Vault badge */}
        {nft.walletType === 'vault' && (
          <span className="absolute top-1.5 right-1.5 text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold bg-green/20 text-green border border-green/30">
            VAULT
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5">
        <div className="text-xs font-medium text-text truncate" title={nft.name}>{nft.name}</div>
        <div className="text-[10px] text-muted truncate mb-2">{nft.collection}</div>
        <div className="flex items-center gap-1.5">
          <a
            href={nft.openseaUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-accent hover:underline flex items-center gap-0.5"
          >
            OS <ExternalLink size={9} />
          </a>
          <a
            href={nft.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-muted hover:text-text flex items-center gap-0.5"
          >
            Scan <ExternalLink size={9} />
          </a>
          {canWithdraw && (
            <button
              onClick={onWithdraw}
              className="ml-auto text-[10px] text-accent2 hover:underline flex items-center gap-0.5"
            >
              <ArrowUpRight size={9} /> Withdraw
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MintHistoryRow({ entry }) {
  const isOk = ['pending', 'success', 'withdrawal_ok'].includes(entry.status)
  const isFailed = ['failed', 'withdrawal_failed'].includes(entry.status)
  const isWithdrawal = entry.status?.includes('withdrawal')
  const txUrl = explorerTxUrl(entry.chain, entry.tx_hash)

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <div className={`mt-0.5 flex-shrink-0 ${isOk ? 'text-green' : isFailed ? 'text-accent2' : 'text-muted'}`}>
        {isOk ? <CheckCircle size={13} /> : isFailed ? <XCircle size={13} /> : <Clock size={13} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium">{isWithdrawal ? 'Vault Withdrawal' : 'Mint'}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
            isOk ? 'bg-green/10 text-green' : isFailed ? 'bg-accent2/10 text-accent2' : 'bg-surface2 text-muted border border-border'
          }`}>{entry.status}</span>
          {entry.chain && (
            <span className="text-[10px] text-muted font-mono">{entry.chain.toUpperCase()}</span>
          )}
        </div>
        {txUrl && entry.tx_hash && (
          <a
            href={txUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-muted hover:text-accent font-mono flex items-center gap-0.5 mt-0.5"
          >
            {entry.tx_hash.slice(0, 14)}… <ExternalLink size={8} />
          </a>
        )}
        {entry.error_message && (
          <div className="text-[10px] text-accent2 mt-0.5 truncate">{entry.error_message}</div>
        )}
      </div>
      <div className="text-[10px] text-muted whitespace-nowrap flex-shrink-0">
        {entry.executed_at
          ? new Date(entry.executed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : ''}
      </div>
    </div>
  )
}

function EthWithdrawModal({ vaultWallet, chain, amount, onAmountChange, toAddress, loading, onConfirm, onClose }) {
  const balance = chain === 'base' ? vaultWallet.balances?.base : vaultWallet.balances?.eth
  // Use BigInt arithmetic to avoid float precision errors on ETH amounts
  // balance is already in ETH (e.g. 0.123456789012345678) — convert via parseEther
  const GAS_RESERVE_WEI = 50_000_000_000_000n // 0.00005 ETH in wei
  const balanceWei = balance != null ? (() => { try { return parseEther(String(balance)) } catch { return 0n } })() : 0n
  const maxSendWei = balanceWei > GAS_RESERVE_WEI ? balanceWei - GAS_RESERVE_WEI : 0n
  const maxSendEth = maxSendWei > 0n ? formatEther(maxSendWei) : '0'
  const addr = vaultWallet.address || vaultWallet.wallet_address
  // Validate amount using BigInt comparison to avoid float precision issues
  const isValid = (() => {
    if (!amount || amount === '0') return false
    try {
      const amtWei = parseEther(String(amount))
      return amtWei > 0n && amtWei <= balanceWei
    } catch { return false }
  })()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-sm p-5 shadow-2xl"
      >
        <h2 className="text-base font-bold mb-1">Withdraw ETH from Vault</h2>
        <p className="text-xs text-muted mb-4">Transfer {chain === 'base' ? 'Base' : 'Ethereum'} ETH to your connected wallet.</p>

        {/* Balance & addresses */}
        <div className="rounded-xl bg-surface2 border border-border p-3 mb-4 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted">Available ({chain === 'base' ? 'Base' : 'ETH'})</span>
            <span className="font-mono font-bold">{balance != null ? Number(balance).toFixed(6) : '—'} ETH</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">From (Alpha Vault)</span>
            <span className="font-mono">{shortAddr(addr)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">To (your wallet)</span>
            <span className="font-mono text-green">{shortAddr(toAddress)}</span>
          </div>
        </div>

        {/* Amount input */}
        <div className="rounded-lg border border-border bg-surface2 p-3 mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-muted">Amount (ETH)</span>
            <button
              onClick={() => onAmountChange(maxSendWei > 0n ? maxSendEth : '0')}
              className="text-[10px] text-accent hover:underline"
            >
              Max
            </button>
          </div>
          <input
            type="number"
            value={amount}
            onChange={e => onAmountChange(e.target.value)}
            placeholder="0.000000"
            step="0.000001"
            min="0"
            className="w-full bg-transparent text-sm font-mono outline-none"
          />
        </div>

        {/* Gas warning */}
        <div className="flex items-start gap-2 bg-amber-500/8 border border-amber-500/20 rounded-lg p-3 mb-4">
          <AlertTriangle size={12} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-400 leading-relaxed">
            Leave a small amount for gas. Max pre-fills with 0.00005 ETH gas reserve.
          </p>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} disabled={loading} className="btn-ghost flex-1">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={loading || !isValid}
            className="btn-primary flex-1 flex items-center justify-center gap-2"
          >
            {loading ? <div className="spinner w-3.5 h-3.5" /> : <Send size={14} />}
            {loading ? 'Withdrawing…' : 'Confirm'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

function WithdrawModal({ nft, toAddress, loading, onConfirm, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-sm p-5 shadow-2xl"
      >
        <h2 className="text-base font-bold mb-1">Withdraw NFT from Vault</h2>
        <p className="text-xs text-muted mb-4">This transfer is signed server-side by your vault wallet.</p>

        {/* NFT preview */}
        <div className="rounded-xl bg-surface2 border border-border p-3 mb-4 flex items-start gap-3">
          {nft.image ? (
            <img
              src={nft.image}
              alt={nft.name}
              className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
              onError={e => { e.target.style.display = 'none' }}
            />
          ) : (
            <div className="w-14 h-14 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
              <ImageOff size={18} className="text-muted opacity-40" />
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{nft.name}</div>
            <div className="text-xs text-muted truncate">{nft.collection}</div>
            <div className="text-[10px] font-mono text-muted mt-1">
              #{nft.tokenId} · {nft.chain?.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Transfer details */}
        <div className="rounded-lg bg-surface2 border border-border p-3 mb-4 text-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted">From (Alpha Vault)</span>
            <span className="font-mono">{shortAddr(nft.owner)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">To (your wallet)</span>
            <span className="font-mono text-green">{shortAddr(toAddress)}</span>
          </div>
        </div>

        {/* Warning */}
        <div className="flex items-start gap-2 bg-amber-500/8 border border-amber-500/20 rounded-lg p-3 mb-4">
          <AlertTriangle size={12} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-400 leading-relaxed">
            Gas fees will be deducted from the vault wallet's ETH balance. Ensure the vault has enough ETH for gas.
          </p>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} disabled={loading} className="btn-ghost flex-1">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="btn-primary flex-1 flex items-center justify-center gap-2"
          >
            {loading ? <div className="spinner w-3.5 h-3.5" /> : <Send size={14} />}
            {loading ? 'Withdrawing…' : 'Confirm'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ─── main page ───────────────────────────────────────────────────────────────

export default function VaultPortfolioPage() {
  const { address: connectedAddress, isConnected } = useAccount()
  const {
    vaultWallets, nfts, mintHistory, loading, error, refresh, hasAlchemyKey,
  } = useVaultPortfolio()

  const [tab, setTab] = useState('All Assets')
  const [withdrawing, setWithdrawing] = useState(null)       // { nft, vaultWallet }
  const [withdrawLoading, setWithdrawLoading] = useState(false)
  const [ethWithdrawing, setEthWithdrawing] = useState(null) // { vaultWallet, chain }
  const [ethWithdrawAmount, setEthWithdrawAmount] = useState('')
  const [ethWithdrawLoading, setEthWithdrawLoading] = useState(false)

  // Filter NFTs by tab
  const filteredNFTs = nfts.filter(nft => {
    if (tab === 'Main Wallet') return nft.walletType === 'main'
    if (tab === 'Alpha Vault') return nft.walletType === 'vault'
    return true
  })

  const nftCount = {
    main: nfts.filter(n => n.walletType === 'main').length,
    vault: nfts.filter(n => n.walletType === 'vault').length,
  }

  const handleWithdrawClick = (nft) => {
    const vaultWallet = vaultWallets.find(v =>
      (v.address || v.wallet_address)?.toLowerCase() === nft.owner?.toLowerCase()
    )
    if (!vaultWallet) {
      toast.error('Could not find vault wallet for this NFT')
      return
    }
    setWithdrawing({ nft, vaultWallet })
  }

  const confirmWithdraw = async () => {
    if (!withdrawing || !connectedAddress) return
    setWithdrawLoading(true)
    console.debug('[vault-withdraw] initiated', {
      vaultWalletId: withdrawing.vaultWallet.id,
      contract: withdrawing.nft.contract?.slice(0, 10),
      chain: withdrawing.nft.chain,
      to: connectedAddress?.slice(0, 10),
    })
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Not authenticated — sign in again')
      const r = await fetch('/api/vault/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vaultWalletId: withdrawing.vaultWallet.id,
          toAddress: connectedAddress,
          type: 'erc721',
          contractAddress: withdrawing.nft.contract,
          tokenId: withdrawing.nft.tokenId,
          chain: withdrawing.nft.chain,
        }),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || d.message || `Server error ${r.status}`)
      toast.success(`NFT withdrawal submitted! TX: ${d.txHash?.slice(0, 14)}…`, { duration: 8000 })
      setWithdrawing(null)
      // Re-check after 8s (allow block time)
      setTimeout(refresh, 8000)
    } catch (err) {
      console.debug('[vault-withdraw] error', err.message)
      toast.error(err.message || 'Withdrawal failed. Check vault ETH balance for gas.')
    } finally {
      setWithdrawLoading(false)
    }
  }

  const handleEthWithdrawClick = (vault, chain) => {
    const bal = chain === 'base' ? (vault.balances?.base ?? 0) : (vault.balances?.eth ?? 0)
    // Use BigInt arithmetic — float subtraction on ETH amounts causes precision errors
    const GAS_RESERVE_WEI = 50_000_000_000_000n // 0.00005 ETH
    let balWei = 0n
    try { balWei = parseEther(String(bal)) } catch {}
    const maxSendWei = balWei > GAS_RESERVE_WEI ? balWei - GAS_RESERVE_WEI : 0n
    setEthWithdrawAmount(maxSendWei > 0n ? formatEther(maxSendWei) : '')
    setEthWithdrawing({ vaultWallet: vault, chain })
  }

  const confirmEthWithdraw = async () => {
    if (!ethWithdrawing || !connectedAddress) return
    const { vaultWallet, chain } = ethWithdrawing
    // Validate with BigInt — parseFloat loses precision on large ETH values
    let amountWei = 0n
    try { amountWei = parseEther(String(ethWithdrawAmount || '0')) } catch {}
    if (amountWei <= 0n) { toast.error('Enter a valid amount'); return }
    setEthWithdrawLoading(true)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Not authenticated — sign in again')
      const r = await fetch('/api/vault/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vaultWalletId: vaultWallet.id,
          toAddress: connectedAddress,
          type: 'native_eth',
          amount: ethWithdrawAmount,
          chain,
        }),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || d.message || `Server error ${r.status}`)
      toast.success(`ETH withdrawal submitted! TX: ${d.txHash?.slice(0, 14)}…`, { duration: 8000 })
      setEthWithdrawing(null)
      setTimeout(refresh, 8000)
    } catch (err) {
      console.debug('[eth-withdraw] error', err.message)
      toast.error(err.message || 'Withdrawal failed. Check vault ETH balance.')
    } finally {
      setEthWithdrawLoading(false)
    }
  }

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Wallet size={20} className="text-accent" />
            <h1 className="text-xl font-bold">Portfolio</h1>
          </div>
          <p className="text-sm text-muted">
            Wallet NFTs, Alpha Vault holdings, and Strike history.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="btn-ghost flex items-center gap-1.5 text-sm"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Alchemy key warning */}
      {!hasAlchemyKey && (
        <div className="card mb-4 border-amber-500/20 bg-amber-500/5 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-amber-400">
            Add your <b>Alchemy API key</b> in <a href="/settings" className="underline">Settings → API Keys</a> to load NFT holdings.
          </p>
        </div>
      )}

      {error && (
        <div className="card mb-4 border-accent2/20 bg-accent2/5">
          <p className="text-sm text-accent2">Failed to load portfolio: {error}</p>
        </div>
      )}

      {/* Wallet Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {/* Connected wallet */}
        {isConnected && connectedAddress && (
          <div className="card">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-xs font-mono text-muted uppercase tracking-wider mb-1">Main Wallet</div>
                <div className="font-mono text-xs text-text break-all">{connectedAddress}</div>
              </div>
              <a
                href={explorerAddressUrl('eth', connectedAddress)}
                target="_blank"
                rel="noreferrer"
                className="text-muted hover:text-accent flex-shrink-0"
              >
                <ExternalLink size={13} />
              </a>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-surface2 border border-border p-2">
                <span className="text-muted block text-[10px]">NFTs (ETH + Base)</span>
                <b>{loading ? '…' : nftCount.main}</b>
              </div>
              <div className="rounded-md bg-surface2 border border-border p-2">
                <span className="text-muted block text-[10px]">Connected</span>
                <b className="text-green text-[10px]">✓ Active</b>
              </div>
            </div>
          </div>
        )}

        {/* Vault wallet cards */}
        {vaultWallets.map(vault => {
          const addr = vault.address || vault.wallet_address
          const vaultNFTCount = nfts.filter(n => n.owner === addr?.toLowerCase()).length
          return (
            <div key={vault.id} className="card border-green/20">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="text-xs font-mono text-muted uppercase tracking-wider mb-1">
                    {vault.label || 'Alpha Vault'}
                  </div>
                  <div className="font-mono text-xs text-green break-all">{addr}</div>
                </div>
                <a
                  href={explorerAddressUrl('eth', addr)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted hover:text-accent flex-shrink-0"
                >
                  <ExternalLink size={13} />
                </a>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-md bg-surface2 border border-border p-2">
                  <span className="text-muted block text-[10px]">NFTs</span>
                  <b>{loading ? '…' : vaultNFTCount}</b>
                </div>
                <div className="rounded-md bg-surface2 border border-border p-2">
                  <span className="text-muted block text-[10px]">ETH</span>
                  <b>{vault.balances?.eth != null ? Number(vault.balances.eth).toFixed(5) : '—'}</b>
                </div>
                <div className="rounded-md bg-surface2 border border-border p-2">
                  <span className="text-muted block text-[10px]">Base</span>
                  <b>{vault.balances?.base != null ? Number(vault.balances.base).toFixed(5) : '—'}</b>
                </div>
              </div>
              {/* ETH withdrawal shortcuts */}
              {isConnected && (vault.balances?.eth > 0 || vault.balances?.base > 0) && (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/50">
                  <span className="text-[10px] text-muted flex-1">Withdraw ETH:</span>
                  {vault.balances?.eth > 0 && (
                    <button
                      onClick={() => handleEthWithdrawClick(vault, 'eth')}
                      className="text-[10px] text-accent2 hover:underline flex items-center gap-0.5"
                    >
                      <ArrowUpRight size={9} /> ETH mainnet
                    </button>
                  )}
                  {vault.balances?.base > 0 && (
                    <button
                      onClick={() => handleEthWithdrawClick(vault, 'base')}
                      className="text-[10px] text-accent2 hover:underline flex items-center gap-0.5"
                    >
                      <ArrowUpRight size={9} /> Base
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* No wallet placeholder */}
        {!isConnected && vaultWallets.length === 0 && !loading && (
          <div className="card border-dashed border-border/50 col-span-2 flex items-center justify-center text-center py-8">
            <div>
              <Wallet size={24} className="mx-auto mb-2 text-muted opacity-30" />
              <p className="text-sm text-muted">Connect your wallet or create an Alpha Vault to see holdings</p>
            </div>
          </div>
        )}
      </div>

      {/* NFT Inventory */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="section-label mb-0">NFT Inventory</div>
          <div className="flex gap-1 flex-wrap">
            {TABS.map(t => {
              const count = t === 'All Assets' ? nfts.length
                : t === 'Main Wallet' ? nftCount.main
                : nftCount.vault
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                    tab === t ? 'bg-accent/20 text-accent' : 'text-muted hover:text-text'
                  }`}
                >
                  {t} ({count})
                </button>
              )
            })}
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="alpha-loader" />
          </div>
        )}

        {!loading && filteredNFTs.length === 0 && (
          <div className="text-center py-12 text-muted">
            <Database size={32} className="mx-auto mb-3 opacity-20" />
            <p className="text-sm">
              {!hasAlchemyKey
                ? 'Add Alchemy API key in Settings to see NFTs'
                : tab === 'Alpha Vault'
                  ? 'No NFTs in Alpha Vault'
                  : tab === 'Main Wallet'
                    ? 'No NFTs found in main wallet'
                    : 'No NFTs found'}
            </p>
          </div>
        )}

        {!loading && filteredNFTs.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {filteredNFTs.map((nft, i) => (
              <NFTCard
                key={`${nft.contract}-${nft.tokenId}-${nft.chain}-${i}`}
                nft={nft}
                canWithdraw={nft.walletType === 'vault' && isConnected && Boolean(connectedAddress)}
                onWithdraw={() => handleWithdrawClick(nft)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Strike & Withdrawal History */}
      <div className="card">
        <div className="section-label">Strike &amp; Withdrawal History</div>
        {loading && mintHistory.length === 0 && (
          <div className="flex items-center justify-center py-6">
            <div className="alpha-loader" />
          </div>
        )}
        {!loading && mintHistory.length === 0 && (
          <p className="text-sm text-muted">No mint or withdrawal history yet.</p>
        )}
        {mintHistory.length > 0 && (
          <div>
            {mintHistory.map((entry, i) => (
              <MintHistoryRow key={entry.id || i} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {/* NFT Withdraw Modal */}
      {withdrawing && (
        <WithdrawModal
          nft={withdrawing.nft}
          toAddress={connectedAddress}
          loading={withdrawLoading}
          onConfirm={confirmWithdraw}
          onClose={() => setWithdrawing(null)}
        />
      )}

      {/* ETH Withdraw Modal */}
      {ethWithdrawing && (
        <EthWithdrawModal
          vaultWallet={ethWithdrawing.vaultWallet}
          chain={ethWithdrawing.chain}
          amount={ethWithdrawAmount}
          onAmountChange={setEthWithdrawAmount}
          toAddress={connectedAddress}
          loading={ethWithdrawLoading}
          onConfirm={confirmEthWithdraw}
          onClose={() => setEthWithdrawing(null)}
        />
      )}
    </div>
  )
}
