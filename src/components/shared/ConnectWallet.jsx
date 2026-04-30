import React, { useState } from 'react'
import { useConnect, useDisconnect, useAccount, useSwitchChain } from 'wagmi'
import { Wallet, ChevronDown, LogOut, Copy, CheckCircle } from 'lucide-react'
import { SUPPORTED_CHAINS } from '../../lib/wallet'
import toast from 'react-hot-toast'

export default function ConnectWallet() {
  const { address, isConnected, chain } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const [showMenu, setShowMenu] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyAddress = () => {
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success('Address copied!')
  }

  if (isConnected && address) {
    return (
      <div className="relative">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-green/30 bg-green/5 text-green text-xs font-mono hover:bg-green/10 transition-all"
        >
          <div className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
          {address.slice(0, 6)}...{address.slice(-4)}
          <ChevronDown size={10} />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-xl shadow-xl z-50 min-w-48 py-1">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-xs text-muted">Connected</p>
              <p className="text-xs font-mono text-text mt-0.5">{address.slice(0,10)}...{address.slice(-6)}</p>
              {chain && <p className="text-[10px] text-accent mt-0.5">{chain.name}</p>}
            </div>
            <button
              onClick={copyAddress}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:text-text hover:bg-surface2 transition-all"
            >
              {copied ? <CheckCircle size={12} className="text-green" /> : <Copy size={12} />}
              Copy address
            </button>
            {Object.entries(SUPPORTED_CHAINS).map(([key, chain]) => (
              <button
                key={key}
                onClick={() => { switchChain({ chainId: chain.id }); setShowMenu(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:text-text hover:bg-surface2 transition-all"
              >
                Switch to {chain.name}
              </button>
            ))}
            <button
              onClick={() => { disconnect(); setShowMenu(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-accent2 hover:bg-accent2/5 transition-all border-t border-border"
            >
              <LogOut size={12} />
              Disconnect
            </button>
          </div>
        )}

        {showMenu && (
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
        )}
      </div>
    )
  }

  return (
    <>
      <button
        onClick={() => setShowConnect(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border2 text-muted text-xs hover:border-accent hover:text-accent transition-all"
      >
        <Wallet size={12} />
        Connect Wallet
      </button>

      {showConnect && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={e => e.target === e.currentTarget && setShowConnect(false)}
        >
          <div className="bg-surface border border-border rounded-2xl w-full max-w-xs p-5">
            <h3 className="font-bold text-sm mb-4 flex items-center gap-2">
              <Wallet size={14} className="text-accent" />
              Connect Wallet
            </h3>
            <div className="space-y-2">
              {connectors.map(connector => (
                <button
                  key={connector.uid}
                  onClick={() => {
                    connect({ connector })
                    setShowConnect(false)
                  }}
                  disabled={isPending}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent hover:bg-accent/5 transition-all text-left"
                >
                  <div className="w-8 h-8 rounded-lg bg-surface2 flex items-center justify-center">
                    <Wallet size={14} className="text-accent" />
                  </div>
                  <div>
                    <div className="text-sm font-medium">{connector.name}</div>
                    <div className="text-xs text-muted">Connect with {connector.name}</div>
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowConnect(false)}
              className="w-full mt-3 btn-ghost text-xs py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}
