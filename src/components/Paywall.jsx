import { useState } from 'react'
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi'
import { isAddress, parseEther } from 'viem'
import toast from 'react-hot-toast'
import { Zap, Clock, Shield, ChevronRight, Loader2, CheckCircle2 } from 'lucide-react'
import ConnectWallet from './shared/ConnectWallet'
import { getAuthToken } from '../lib/supabase'

const TREASURY_ADDRESS =
  import.meta.env.VITE_TREASURY_ADDRESS ||
  import.meta.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
  import.meta.env.VITE_RECEIVER_WALLET

const PLANS = [
  {
    id: 'weekly',
    label: '7 Days',
    priceEth: '0.0015',
    priceUSD: '~$5',
    color: 'from-cyan-500/20 to-cyan-500/5',
    border: 'border-cyan-500/30',
    accent: 'text-cyan-400',
    badge: null,
  },
  {
    id: 'monthly',
    label: '30 Days',
    priceEth: '0.005',
    priceUSD: '~$15',
    color: 'from-violet-500/20 to-violet-500/5',
    border: 'border-violet-500/40',
    accent: 'text-violet-400',
    badge: 'POPULAR',
  },
  {
    id: 'quarterly',
    label: '90 Days',
    priceEth: '0.012',
    priceUSD: '~$35',
    color: 'from-amber-500/20 to-amber-500/5',
    border: 'border-amber-500/30',
    accent: 'text-amber-400',
    badge: 'BEST VALUE',
  },
]

const FEATURES = [
  { icon: Shield, text: 'MintGuard — WL tracker + auto-mint' },
  { icon: Zap, text: 'WhaleRadar — real-time wallet alerts' },
  { icon: Clock, text: 'Alpha Tools — forensic wallet analysis' },
]

const SUPPORTED_PAYMENT_CHAINS = new Set([1, 8453, 56])

export default function Paywall({ onSuccess, expired = false }) {
  const { address, chain, isConnected } = useAccount()
  const [selectedPlan, setSelectedPlan] = useState('monthly')
  const [step, setStep] = useState('select')
  const [pendingTxHash, setPendingTxHash] = useState(null)

  const { sendTransactionAsync } = useSendTransaction()
  const publicClient = usePublicClient()
  const treasuryValid = Boolean(TREASURY_ADDRESS && isAddress(TREASURY_ADDRESS))
  const supportedChain = !chain?.id || SUPPORTED_PAYMENT_CHAINS.has(chain.id)
  const processing = step !== 'select'
  const plan = PLANS.find(p => p.id === selectedPlan)

  const handlePay = async () => {
    if (!isConnected || !address) {
      toast.error('Connect your wallet first')
      return
    }

    if (!plan) {
      toast.error('Select a plan first')
      return
    }

    if (!treasuryValid) {
      toast.error('Payment is temporarily unavailable. Please try again later.')
      return
    }

    if (!supportedChain) {
      toast.error('Wrong network or unsupported chain')
      return
    }

    if (processing) return

    try {
      setStep('confirming')

      if (import.meta.env.DEV) {
        console.info('payment:start', {
          selectedPlan: plan.id,
          from: address,
          treasury: TREASURY_ADDRESS,
          chainId: chain?.id,
          valueEth: plan.priceEth,
        })
      }

      const txHash = await sendTransactionAsync({
        to: TREASURY_ADDRESS,
        value: parseEther(plan.priceEth),
      })

      setPendingTxHash(txHash)
      setStep('verifying')

      if (!publicClient) throw new Error('RPC unavailable. Try again in a moment.')

      await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before verifying payment')

      const res = await fetch('/api/payments/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          txHash,
          walletAddress: address,
          planId: selectedPlan,
          chainId: chain?.id,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Verification failed')
      }

      setStep('done')
      toast.success('Subscription activated.')

      setTimeout(() => {
        onSuccess?.()
      }, 2000)

    } catch (err) {
      setStep('select')
      if (err.message?.includes('rejected') || err.code === 4001) {
        toast.error('Transaction cancelled')
      } else if (err.message?.toLowerCase().includes('insufficient')) {
        toast.error('Insufficient funds for this payment')
      } else if (err.message?.toLowerCase().includes('chain') || err.message?.toLowerCase().includes('network')) {
        toast.error('Wrong network or unsupported chain')
      } else if (err.message?.toLowerCase().includes('treasury') || err.message?.toLowerCase().includes('address')) {
        toast.error('Payment is temporarily unavailable. Please try again later.')
      } else {
        toast.error(err.message || 'Payment failed. Please try again.')
      }
    }
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <div className="w-20 h-20 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10 text-green-400" />
          </div>
          <h2 className="text-2xl font-bold text-white">Access Activated</h2>
          <p className="text-gray-400">Loading Alpha Hub...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center p-6">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-violet-600/5 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg space-y-6">

        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-mono uppercase tracking-widest mb-3">
            <Zap className="w-3 h-3" />
            Alpha Hub
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">
            On-Chain Intelligence
          </h1>
          <p className="text-gray-400 text-sm">
            {expired
              ? 'Your access expired. Renew to continue.'
              : 'Pay with your wallet. No account needed. Access is instant.'}
          </p>
        </div>

        {/* Wallet connect — shown when not connected */}
        {!isConnected && (
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-sm text-gray-500">Connect your wallet to get started</p>
            <ConnectWallet />
          </div>
        )}

        {/* Connected wallet indicator */}
        {isConnected && (
          <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-green-500/5 border border-green-500/20">
            <span className="text-xs text-green-400 font-mono">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </span>
            <ConnectWallet />
          </div>
        )}

        {/* Features */}
        <div className="grid grid-cols-1 gap-2">
          {FEATURES.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
              <Icon className="w-4 h-4 text-violet-400 shrink-0" />
              <span className="text-sm text-gray-300">{text}</span>
            </div>
          ))}
        </div>

        {/* Plan selector */}
        <div className="grid grid-cols-3 gap-3">
          {PLANS.map(plan => (
            <button
              key={plan.id}
              onClick={() => setSelectedPlan(plan.id)}
              className={`relative flex flex-col items-center p-4 rounded-xl border transition-all duration-200 text-left ${
                selectedPlan === plan.id
                  ? `bg-gradient-to-b ${plan.color} ${plan.border} scale-[1.02]`
                  : 'bg-white/[0.03] border-white/[0.08] hover:border-white/20'
              }`}
            >
              {plan.badge && (
                <span className={`absolute -top-2.5 left-1/2 -translate-x-1/2 text-[9px] font-bold px-2 py-0.5 rounded-full bg-[#0a0b0f] border ${plan.border} ${plan.accent} whitespace-nowrap`}>
                  {plan.badge}
                </span>
              )}
              <span className="text-xs text-gray-400 mb-1">{plan.label}</span>
              <span className={`text-lg font-bold ${selectedPlan === plan.id ? plan.accent : 'text-white'}`}>
                {plan.priceEth}
              </span>
              <span className="text-[10px] text-gray-500">ETH</span>
              <span className="text-[10px] text-gray-500 mt-0.5">{plan.priceUSD}</span>
            </button>
          ))}
        </div>

        {/* Pay button — only active when wallet connected */}
        <button
          onClick={handlePay}
          disabled={processing || !isConnected || !treasuryValid || !supportedChain || !plan}
          className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-semibold text-white transition-all duration-200
            ${isConnected && treasuryValid && supportedChain
              ? 'bg-violet-600 hover:bg-violet-500 cursor-pointer'
              : 'bg-violet-600/30 cursor-not-allowed opacity-50'
            }`}
        >
          {step === 'confirming' && (
            <><Loader2 className="w-4 h-4 animate-spin" /> Confirm in wallet...</>
          )}
          {step === 'verifying' && (
            <><Loader2 className="w-4 h-4 animate-spin" /> Confirming payment on-chain...</>
          )}
          {step === 'select' && (
            <>
              {!treasuryValid
                ? 'Payment temporarily unavailable'
                : !supportedChain
                ? 'Switch to ETH, Base, or BNB'
                : isConnected
                ? <>Pay {PLANS.find(p => p.id === selectedPlan)?.priceEth} ETH <ChevronRight className="w-4 h-4" /></>
                : 'Connect wallet to continue'
              }
            </>
          )}
        </button>

        {pendingTxHash && step === 'verifying' && (
          <p className="text-center text-xs text-gray-500 font-mono break-all">
            tx: {pendingTxHash}
          </p>
        )}

        <p className="text-center text-xs text-gray-600">
          Payment goes directly on-chain. Access activates on confirmation.
        </p>
      </div>
    </div>
  )
}
