export const PAYMENT_CONFIG = {
  receiverAddress: '0x73BB3FD47A67254635A86030c3Fd742219f155AB',
  chainId: 8453,
  chainName: 'Base',
  tokenSymbol: 'ETH',
  explorerBaseUrl: 'https://basescan.org/tx',
  activationMode: process.env.PAYMENT_ACTIVATION_MODE || 'manual',
}

export const PRICING_PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsdMonthly: 0,
    priceUsdAnnual: 0,
    durationDaysMonthly: 30,
    durationDaysAnnual: 365,
    enabled: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsdMonthly: 19,
    priceUsdAnnual: 190,
    durationDaysMonthly: 30,
    durationDaysAnnual: 365,
    enabled: true,
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    priceUsdMonthly: 49,
    priceUsdAnnual: 490,
    durationDaysMonthly: 30,
    durationDaysAnnual: 365,
    enabled: true,
  },
}

export function getPaymentChainKey() {
  return 'base'
}

export function getPaymentChain() {
  return {
    id: PAYMENT_CONFIG.chainId,
    key: 'base',
    name: PAYMENT_CONFIG.chainName,
    label: PAYMENT_CONFIG.chainName,
    testnet: false,
  }
}

export function getActivationMode() {
  return PAYMENT_CONFIG.activationMode === 'automatic' ? 'automatic' : 'manual'
}

export function getPlan(planId) {
  const plan = PRICING_PLANS[planId]
  return plan?.enabled ? plan : null
}

export function getPlanPriceUsd(plan, billingCycle = 'monthly') {
  return billingCycle === 'annual' ? plan.priceUsdAnnual : plan.priceUsdMonthly
}

export function getPlanDurationDays(plan, billingCycle = 'monthly') {
  return billingCycle === 'annual' ? plan.durationDaysAnnual : plan.durationDaysMonthly
}

export function subscriptionPlanForTier(planId) {
  if (planId === 'elite') return 'quarterly'
  if (planId === 'pro') return 'monthly'
  if (planId === 'free') return 'weekly'
  return planId
}

export function tierFromSubscriptionPlan(plan) {
  if (plan === 'quarterly' || plan === 'founder' || plan === 'elite') return 'elite'
  if (plan === 'monthly' || plan === 'pro') return 'pro'
  if (plan === 'weekly' || plan === 'free') return 'free'
  return 'free'
}
