import { useEffect, useMemo, useState } from 'react'
import { useAccount, useDisconnect, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi'
import { parseEther } from 'viem'
import toast from 'react-hot-toast'
import { ArrowLeft, Check, CheckCircle2, ChevronRight, Clock, Loader2, Repeat2, Shield, Wallet, Zap } from 'lucide-react'
import ConnectWallet from './shared/ConnectWallet'
import { getAuthToken } from '../lib/supabase'
import { useAuthStore } from '../store'
import { PAYMENT_CONFIG, getPlanPriceUsd, roundUpEthAmount } from '../config/payments'
import { friendlyError } from '../lib/errors'

const PLAN_ORDER = ['free', 'pro', 'elite']

const PLAN_BADGES = {
  pro: 'Recommended',
  elite: 'Power Users',
}

const STATE_LABELS = {
  pricing: 'Choose plan',
  calculating: 'Calculating ETH price',
  confirming: 'Awaiting wallet confirmation',
  confirmingChain: 'Confirming payment on-chain',
  submitting: 'Submitting payment',
  pending: 'Pending admin approval',
  active: 'Subscription active',
}

export default function Paywall({
  onSuccess,
  expired = false,
  showBack = false,
  requiredPlan = null,
  lockMessage = null,
  currentPlan = null,
}) {
  const { address, chain, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()
  const signOut = useAuthStore(s => s.signOut)

  const [billingCycle, setBillingCycle] = useState('monthly')
  const [selectedPlanId, setSelectedPlanId] = useState(requiredPlan || 'pro')
  const [ethPrice, setEthPrice] = useState(null)
  const [priceLoading, setPriceLoading] = useState(false)
  const [step, setStep] = useState('pricing')
  const [pendingTxHash, setPendingTxHash] = useState(null)
  const [submittedAmount, setSubmittedAmount] = useState(null)

  const plans = useMemo(() => PLAN_ORDER.map(id => PAYMENT_CONFIG.plans[id]).filter(Boolean), [])
  const selectedPlan = PAYMENT_CONFIG.plans[selectedPlanId]
  const usdPrice = selectedPlan ? getPlanPriceUsd(selectedPlan, billingCycle) : 0
  const ethAmount = selectedPlanId === 'free' ? 0 : roundUpEthAmount(usdPrice, ethPrice)
  const isBase = chain?.id === PAYMENT_CONFIG.chainId
  const processing = !['pricing', 'pending', 'active'].includes(step)
  const activationMode = PAYMENT_CONFIG.activationMode === 'automatic' ? 'automatic' : 'manual'

  useEffect(() => {
    if (selectedPlanId === 'free') return
    let cancelled = false
    setPriceLoading(true)
    fetch('/api/eth-price')
      .then(res => res.json().then(data => {
        if (!res.ok) throw new Error(data.error || 'ETH price unavailable')
        return data
      }))
      .then(data => {
        if (!cancelled) setEthPrice(Number(data.ethUsd))
      })
      .catch(err => {
        if (!cancelled) toast.error(err.message || 'ETH price unavailable')
      })
      .finally(() => {
        if (!cancelled) setPriceLoading(false)
      })
    return () => { cancelled = true }
  }, [selectedPlanId, billingCycle])

  async function ensureBase() {
    if (isBase) return
    if (!switchChainAsync) throw new Error('Switch to Base to pay')
    await switchChainAsync({ chainId: PAYMENT_CONFIG.chainId })
  }

  async function submitFreePlan() {
    if (!address) throw new Error('Connect your wallet first')
    const token = await getAuthToken()
    if (!token) throw new Error('Sign in again before continuing')

    const res = await fetch('/api/payments/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        planId: 'free',
        billingCycle,
        walletAddress: address,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not activate Free plan')
    toast.success('Free plan activated.')
    await Promise.resolve(onSuccess?.())
    window.location.href = '/'
  }

  async function handlePay() {
    if (processing) return
    if (!isConnected || !address) {
      toast.error('Connect your wallet first')
      return
    }
    if (!selectedPlan) {
      toast.error('Choose a plan first')
      return
    }

    try {
      if (selectedPlanId === 'free') {
        setStep('submitting')
        await submitFreePlan()
        setStep('active')
        return
      }

      if (!ethPrice || !ethAmount) {
        throw new Error('ETH price is still loading. Try again in a moment.')
      }

      if (!isBase) {
        toast('Switching wallet to Base')
        await ensureBase()
      }

      setStep('confirming')
      const txHash = await sendTransactionAsync({
        to: PAYMENT_CONFIG.receiverAddress,
        value: parseEther(String(ethAmount)),
        chainId: PAYMENT_CONFIG.chainId,
      })

      setPendingTxHash(txHash)
      setSubmittedAmount(ethAmount)
      setStep('confirmingChain')

      if (!publicClient) throw new Error('RPC unavailable. Try again in a moment.')
      await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 })

      const token = await getAuthToken()
      if (!token) throw new Error('Sign in again before submitting payment')

      setStep('submitting')
      const createRes = await fetch('/api/payments/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId: selectedPlanId,
          billingCycle,
          walletAddress: address,
          txHash,
          chainId: PAYMENT_CONFIG.chainId,
          amountEth: ethAmount,
          amountUsd: usdPrice,
          ethUsd: ethPrice,
          receiverAddress: PAYMENT_CONFIG.receiverAddress,
        }),
      })

      const created = await createRes.json()
      if (!createRes.ok) throw new Error(created.error || 'Could not submit payment')

      if (activationMode === 'automatic') {
        const verifyRes = await fetch('/api/payments/verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            txHash,
            walletAddress: address,
            planId: selectedPlanId,
            billingCycle,
          }),
        })
        const verified = await verifyRes.json()
        if (!verifyRes.ok) throw new Error(verified.error || 'Payment verification failed')
        toast.success('Subscription activated.')
        setStep('active')
        await Promise.resolve(onSuccess?.())
        window.location.href = '/'
        return
      }

      toast.success('Payment submitted for admin review.')
      setStep('pending')
      await Promise.resolve(onSuccess?.())
    } catch (err) {
      console.error('payment flow error:', err)
      setStep('pricing')
      if (err.code === 4001 || err.message?.toLowerCase().includes('rejected')) {
        toast.error('Transaction cancelled')
      } else if (err.message?.toLowerCase().includes('wallet does not match')) {
        toast.error('This session is signed in with another wallet. Sign out, then reconnect the right wallet.')
      } else if (err.message?.toLowerCase().includes('insufficient')) {
        toast.error('Insufficient ETH on Base')
      } else if (err.message?.toLowerCase().includes('chain') || err.message?.toLowerCase().includes('network')) {
        toast.error('Switch to Base to pay')
      } else {
        toast.error(friendlyError(err, 'Payment is temporarily unavailable. Please try again.'))
      }
    }
  }

  async function handleSwitchSession() {
    await signOut()
    disconnect()
    window.location.href = '/auth'
  }

  function handleBack() {
    if (window.history.length > 1) {
      window.history.back()
    } else {
      window.location.href = '/'
    }
  }

  if (step === 'active') {
    return (
      <div className="min-h-screen bg-[#070a0f] flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <div className="w-20 h-20 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10 text-green-400" />
          </div>
          <h2 className="text-2xl font-bold text-white">Subscription active</h2>
          <p className="text-gray-400">Loading Alpha Hub...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#070a0f] text-white flex items-center justify-center p-4 lg:p-6">
      <div className="w-full max-w-6xl space-y-6">
        {showBack && (
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:border-cyan-400/40 hover:text-cyan-200"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to app
          </button>
        )}

        <div className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs font-mono uppercase tracking-widest">
            <Zap className="w-3 h-3" />
            Alpha Hub
          </div>
          <h1 className="text-3xl lg:text-4xl font-bold tracking-tight">Choose your Alpha Hub plan</h1>
          <p className="text-gray-400 max-w-2xl mx-auto">
            Real-time wallet intelligence, Telegram alerts, automint tools, and forensic reports.
          </p>
          {expired && <p className="text-amber-300 text-sm">Your access expired. Renew to continue.</p>}
          {lockMessage && (
            <div className="mx-auto max-w-xl rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {lockMessage} {currentPlan === 'pending' ? 'Your payment is pending admin approval.' : 'Upgrade to continue.'}
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-1">
            {['monthly', 'annual'].map(cycle => (
              <button
                key={cycle}
                onClick={() => setBillingCycle(cycle)}
                className={`px-4 py-2 rounded-md text-sm font-semibold capitalize transition-all ${
                  billingCycle === cycle ? 'bg-cyan-500 text-black' : 'text-gray-400 hover:text-white'
                }`}
              >
                {cycle}
              </button>
            ))}
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
            <Wallet className="w-3.5 h-3.5" />
            Payments are made in ETH on Base for low gas fees.
          </div>
        </div>

        {!isConnected && (
          <div className="flex items-center justify-center">
            <ConnectWallet />
          </div>
        )}

        {isConnected && (
          <div className="mx-auto max-w-xl rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-xs text-gray-500">Connected wallet</p>
              <p className="text-sm font-mono text-cyan-200">{address?.slice(0, 8)}...{address?.slice(-6)}</p>
            </div>
            <div className="flex items-center gap-2">
              <ConnectWallet />
              <button
                onClick={handleSwitchSession}
                className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:border-cyan-400/40 hover:text-cyan-200"
              >
                <Repeat2 className="w-3.5 h-3.5" />
                Sign out / switch
              </button>
            </div>
          </div>
        )}

        {isConnected && selectedPlanId !== 'free' && !isBase && (
          <button
            onClick={() => ensureBase().catch(() => toast.error('Switch to Base to pay'))}
            className="mx-auto flex items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-500/15"
          >
            Switch to Base to pay
          </button>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {plans.map(plan => {
            const isSelected = selectedPlanId === plan.id
            const price = getPlanPriceUsd(plan, billingCycle)
            const badge = PLAN_BADGES[plan.id]
            return (
              <button
                key={plan.id}
                onClick={() => setSelectedPlanId(plan.id)}
                className={`relative text-left rounded-xl border p-5 bg-[#0d1117] transition-all ${
                  isSelected ? 'border-cyan-400 shadow-[0_0_0_1px_rgba(34,211,238,.35)]' : 'border-white/10 hover:border-white/25'
                }`}
              >
                {badge && (
                  <span className={`absolute right-4 top-4 rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
                    plan.id === 'pro' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-violet-500/15 text-violet-300'
                  }`}>
                    {badge}
                  </span>
                )}
                <div className="space-y-4">
                  <div>
                    <h2 className="text-xl font-bold">{plan.name}</h2>
                    <div className="mt-3 flex items-end gap-1">
                      <span className="text-3xl font-bold">${price}</span>
                      <span className="text-gray-500 text-sm mb-1">/{billingCycle === 'annual' ? 'year' : 'month'}</span>
                    </div>
                    {billingCycle === 'annual' && plan.id !== 'free' && (
                      <p className="text-xs text-green-300 mt-1">Roughly 2 months free</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    {plan.features.map(feature => (
                      <div key={feature} className="flex items-start gap-2 text-sm text-gray-300">
                        <Check className="w-4 h-4 text-cyan-300 mt-0.5 shrink-0" />
                        <span>{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        <div className="rounded-xl border border-white/10 bg-[#0d1117] p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold flex items-center gap-2">
                <Shield className="w-4 h-4 text-cyan-300" />
                {STATE_LABELS[step] || 'Payment'}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {selectedPlanId === 'free'
                  ? 'Free access unlocks the basic dashboard, limited wallet checks, and limited mint tracking.'
                  : activationMode === 'manual'
                  ? 'After payment, your subscription enters review and will be activated after confirmation.'
                  : 'Payment will activate automatically after on-chain verification.'}
              </p>
            </div>
            <div className="text-sm text-gray-300">
              {selectedPlanId === 'free'
                ? 'No payment required'
                : priceLoading
                ? 'Loading ETH quote...'
                : ethAmount
                ? `${ethAmount} ETH on Base`
                : 'ETH quote unavailable'}
            </div>
          </div>

          <button
            onClick={handlePay}
            disabled={processing || !isConnected || (selectedPlanId !== 'free' && (!ethAmount || priceLoading))}
            className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-semibold transition-all ${
              !processing && isConnected && (selectedPlanId === 'free' || ethAmount)
                ? 'bg-cyan-400 text-black hover:bg-cyan-300'
                : 'bg-cyan-400/30 text-white/60 cursor-not-allowed'
            }`}
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            {step === 'pricing' && (
              <>
                {!isConnected
                  ? 'Connect wallet to continue'
                  : selectedPlanId === 'free'
                  ? 'Continue with Free'
                  : !isBase
                  ? 'Switch to Base and pay'
                  : `Pay ${ethAmount || '...'} ETH`}
                <ChevronRight className="w-4 h-4" />
              </>
            )}
            {step !== 'pricing' && (STATE_LABELS[step] || 'Processing payment')}
          </button>

          {step === 'pending' && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
              Payment submitted. Access will activate after admin review.
            </div>
          )}

          {pendingTxHash && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-gray-500">
              <span className="font-mono break-all">tx: {pendingTxHash}</span>
              <a
                href={`${PAYMENT_CONFIG.explorerBaseUrl}/${pendingTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-300 hover:text-cyan-200 whitespace-nowrap"
              >
                View on BaseScan
              </a>
            </div>
          )}

          {submittedAmount && (
            <div className="text-xs text-gray-500 flex items-center gap-2">
              <Clock className="w-3.5 h-3.5" />
              Submitted {submittedAmount} ETH to {PAYMENT_CONFIG.receiverAddress.slice(0, 6)}...{PAYMENT_CONFIG.receiverAddress.slice(-4)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
