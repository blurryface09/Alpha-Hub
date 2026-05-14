import { PAYMENT_CONFIG } from '../config/payments'

export type BillingCycle = 'monthly' | 'annual'

export type PricingPlan = {
  id: string
  name: string
  priceUsdMonthly: number
  priceUsdAnnual: number
  durationDaysMonthly: number
  durationDaysAnnual: number
  features: string[]
}

export const PRICING_PLANS = Object.values(PAYMENT_CONFIG.plans) as PricingPlan[]

export function getPlan(planId: string) {
  return PAYMENT_CONFIG.plans[planId as keyof typeof PAYMENT_CONFIG.plans] || null
}

export function getPaymentChain() {
  return {
    id: PAYMENT_CONFIG.chainId,
    key: 'base',
    name: PAYMENT_CONFIG.chainName,
    label: PAYMENT_CONFIG.chainName,
    testnet: false,
    switchMessage: 'Switch to Base to pay',
  }
}

export function getPaymentChainKey() {
  return 'base'
}
