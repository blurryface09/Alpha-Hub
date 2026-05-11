export type PaymentChainId = 'base' | 'baseSepolia'

export type PricingPlan = {
  id: string
  name: string
  durationDays: number
  priceEth: string
  approxUsd: string
  badge: string | null
  isPopular: boolean
  enabled: boolean
  testOnly: boolean
}

export const PAYMENT_CHAINS = {
  base: {
    id: 8453,
    key: 'base',
    name: 'Base',
    label: 'Base Mainnet',
    testnet: false,
    switchMessage: 'Switch to Base to pay',
  },
  baseSepolia: {
    id: 84532,
    key: 'baseSepolia',
    name: 'Base Sepolia',
    label: 'Base Sepolia Testnet',
    testnet: true,
    switchMessage: 'Switch to Base Sepolia to test payment',
  },
} as const

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'test',
    name: 'Test Plan',
    durationDays: 1,
    priceEth: '0.000001',
    approxUsd: 'test ETH',
    badge: 'TEST',
    isPopular: false,
    enabled: true,
    testOnly: true,
  },
  {
    id: 'weekly',
    name: 'Starter',
    durationDays: 7,
    priceEth: '0.001',
    approxUsd: '~$3',
    badge: null,
    isPopular: false,
    enabled: true,
    testOnly: false,
  },
  {
    id: 'monthly',
    name: 'Popular',
    durationDays: 30,
    priceEth: '0.0035',
    approxUsd: '~$10',
    badge: 'POPULAR',
    isPopular: true,
    enabled: true,
    testOnly: false,
  },
  {
    id: 'quarterly',
    name: 'Best Value',
    durationDays: 90,
    priceEth: '0.009',
    approxUsd: '~$25',
    badge: 'BEST VALUE',
    isPopular: false,
    enabled: true,
    testOnly: false,
  },
  {
    id: 'founder',
    name: 'Founder',
    durationDays: 3650,
    priceEth: '0.025',
    approxUsd: '~$70',
    badge: 'FOUNDER',
    isPopular: false,
    enabled: false,
    testOnly: false,
  },
]

export function getPaymentChainKey(): PaymentChainId | null {
  const value = import.meta.env.NEXT_PUBLIC_PAYMENT_CHAIN || import.meta.env.VITE_PAYMENT_CHAIN
  return value === 'base' || value === 'baseSepolia' ? value : null
}

export function getPaymentChain() {
  const key = getPaymentChainKey()
  return key ? PAYMENT_CHAINS[key] : null
}

export function isTestPaymentMode() {
  return getPaymentChainKey() === 'baseSepolia' || import.meta.env.DEV
}

export function getVisiblePricingPlans() {
  const testMode = isTestPaymentMode()
  return PRICING_PLANS.filter((plan) => {
    if (!plan.enabled) return false
    if (plan.testOnly) return testMode
    return !testMode || getPaymentChainKey() !== 'baseSepolia'
  })
}
