export const PAYMENT_CHAINS = {
  base: {
    id: 8453,
    key: 'base',
    name: 'Base',
    label: 'Base Mainnet',
    testnet: false,
  },
  baseSepolia: {
    id: 84532,
    key: 'baseSepolia',
    name: 'Base Sepolia',
    label: 'Base Sepolia Testnet',
    testnet: true,
  },
}

export const PRICING_PLANS = {
  test: {
    id: 'test',
    name: 'Test Plan',
    durationDays: 1,
    priceEth: '0.000001',
    enabled: true,
    testOnly: true,
  },
  weekly: {
    id: 'weekly',
    name: 'Starter',
    durationDays: 7,
    priceEth: '0.001',
    enabled: true,
    testOnly: false,
  },
  monthly: {
    id: 'monthly',
    name: 'Popular',
    durationDays: 30,
    priceEth: '0.0035',
    enabled: true,
    testOnly: false,
  },
  quarterly: {
    id: 'quarterly',
    name: 'Best Value',
    durationDays: 90,
    priceEth: '0.009',
    enabled: true,
    testOnly: false,
  },
  founder: {
    id: 'founder',
    name: 'Founder',
    durationDays: 3650,
    priceEth: '0.025',
    enabled: false,
    testOnly: false,
  },
}

export function getPaymentChainKey() {
  const key = process.env.NEXT_PUBLIC_PAYMENT_CHAIN || process.env.VITE_PAYMENT_CHAIN
  return key === 'base' || key === 'baseSepolia' ? key : null
}

export function getPaymentChain() {
  const key = getPaymentChainKey()
  return key ? PAYMENT_CHAINS[key] : null
}

export function isTestPaymentMode() {
  return getPaymentChainKey() === 'baseSepolia' || process.env.NODE_ENV !== 'production'
}

export function getPlan(planId) {
  const plan = PRICING_PLANS[planId]
  if (!plan || !plan.enabled) return null
  if (plan.testOnly && !isTestPaymentMode()) return null
  if (!plan.testOnly && getPaymentChainKey() === 'baseSepolia') return null
  return plan
}
