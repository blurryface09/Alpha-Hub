import { useState } from 'react'
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi'
import { isAddress, parseEther } from 'viem'
import toast from 'react-hot-toast'
import { Zap, Clock, Shield, ChevronRight, Loader2, CheckCircle2 } from 'lucide-react'
import ConnectWallet from './shared/ConnectWallet'
import { getAuthToken } from '../lib/supabase'
import { getPaymentChain, getVisiblePricingPlans } from '../lib/pricing'

const TREASURY_ADDRESS =
  import.meta.env.VITE_TREASURY_ADDRESS ||
  import.meta.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
  import.meta.env.VITE_RECEIVER_WALLET

const FEATURES = [
  { icon: Shield, text: 'MintGuard — WL tracker + auto-mint' },
  { icon: Zap, text: 'WhaleRadar — real-time wallet alerts' },
  { icon: Clock, text: 'Alpha Tools — forensic wallet analysis' },
]

const PLAN_STYLES = {
  test: {
    color: 'from-emerald-500/20 to-emerald-500/5',
    border: 'border-emerald-500/30',
    accent: 'text-emerald-400',
  },
  weekly: {
    color: 'from-cyan-500/20 to-cyan-500/5',
    border: 'border-cyan-500/30',
    accent: 'text-cyan-400',
  },
  monthly: {
    color: 'from-violet-500/20 to-violet-500/5',
    border: 'border-violet-500/40',
    accent: 'text-violet-400',
  },
  quarterly: {
    color: 'from-amber-500/20 to-amber-500/5',
    border: 'border-amber-500/30',
    accent: 'text-amber-400',
  },
  founder: {
    color: 'from-rose-500/20 to-rose-500/5',
    border: 'border-rose-500/30',
    accent: 'text-rose-400',
  },
}

export default function Paywall({ onSuccess, expired = false }) {
  const { address, chain, isConnected } = useAccount()
  const paymentChain = getPaymentChain()
  const plans = getVisiblePricingPlans()
  const defaultPlan = plans.find(plan => plan.isPopular)?.id || plans[0]?.id || ''
  const [selectedPlan, setSelectedPlan] = useState(defaultPlan)
  const [step, setStep] = useState('select')
  const [pendingTxHash, setPendingTxHash] = useState(null)

  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()
  const treasuryValid = Boolean(TREASURY_ADDRESS && isAddress(TREASURY_ADDRESS))
  const paymentChainConfigured = Boolean(paymentChain)
  const supportedChain = Boolean(paymentChain && chain?.id === paymentChain.id)
  const paymentConfigComplete = treasuryValid && paymentChainConfigured
  const processing = step !== 'select'
  const plan = plans.find(p => p.id === selectedPlan) || plans[0]
  const isTestMode = paymentChain?.key === 'baseSepolia'

  const handlePay = async () => {
    if (!isConnected || !address) {
      toast.error('Connect your wallet first')
      return
    }

    if (!plan) {
      toast.error('Select a plan first')
      return
    }

    if (!paymentConfigComplete) {
      toast.error('Payment is temporarily unavailable. Please try again later.')
      return
    }

    if (!supportedChain) {
      toast.error(paymentChain.switchMessage)
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
          paymentChain: paymentChain.key,
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
          chainId: paymentChain.id,
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
        toast.error(paymentChain?.switchMessage || 'Wrong network or unsupported chain')
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
              : isTestMode
              ? 'Test payments use Base Sepolia ETH. No real ETH required.'
              : 'Pay on Base. No account needed. Access is instant.'}
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
            <div>
              <span className="text-xs text-green-400 font-mono">
                {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <div className="text-[10px] text-gray-500 mt-0.5">
                {chain?.name || 'Unknown network'}
              </div>
            </div>
            <ConnectWallet />
          </div>
        )}

        {!paymentConfigComplete && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">
            Payment config incomplete. Add NEXT_PUBLIC_PAYMENT_CHAIN, NEXT_PUBLIC_TREASURY_ADDRESS, and TREASURY_ADDRESS.
          </div>
        )}

        {isConnected && paymentConfigComplete && !supportedChain && paymentChain && (
          <button
            onClick={() => switchChainAsync?.({ chainId: paymentChain.id }).catch(() => toast.error(paymentChain.switchMessage))}
            className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-500/15 transition-all"
          >
            {paymentChain.switchMessage}
          </button>
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
        <div className={`grid gap-3 ${plans.length === 1 ? 'grid-cols-1' : plans.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {plans.map(plan => {
            const style = PLAN_STYLES[plan.id] || PLAN_STYLES.monthly
            return (
            <button
              key={plan.id}
              onClick={() => setSelectedPlan(plan.id)}
              className={`relative flex flex-col items-center p-4 rounded-xl border transition-all duration-200 text-left ${
                selectedPlan === plan.id
                  ? `bg-gradient-to-b ${style.color} ${style.border} scale-[1.02]`
                  : 'bg-white/[0.03] border-white/[0.08] hover:border-white/20'
              }`}
            >
              {plan.badge && (
                <span className={`absolute -top-2.5 left-1/2 -translate-x-1/2 text-[9px] font-bold px-2 py-0.5 rounded-full bg-[#0a0b0f] border ${style.border} ${style.accent} whitespace-nowrap`}>
                  {plan.badge}
                </span>
              )}
              <span className="text-xs text-gray-400 mb-1">{plan.name}</span>
              <span className={`text-lg font-bold ${selectedPlan === plan.id ? style.accent : 'text-white'}`}>
                {plan.priceEth}
              </span>
              <span className="text-[10px] text-gray-500">ETH</span>
              <span className="text-[10px] text-gray-500 mt-0.5">{plan.approxUsd}</span>
            </button>
          )})}
        </div>

        {/* Pay button — only active when wallet connected */}
        <button
          onClick={handlePay}
          disabled={processing || !isConnected || !paymentConfigComplete || !supportedChain || !plan}
          className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-semibold text-white transition-all duration-200
            ${isConnected && paymentConfigComplete && supportedChain
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
              {!paymentConfigComplete
                ? 'Payment temporarily unavailable'
                : !supportedChain
                ? paymentChain.switchMessage
                : isConnected
                ? <>Pay {plan?.priceEth} ETH <ChevronRight className="w-4 h-4" /></>
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
          Payment goes directly on-chain on {paymentChain?.label || 'the configured network'}. Access activates after server verification.
        </p>
      </div>
    </div>
  )
}
