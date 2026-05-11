export const PAYMENT_CONFIG = {
  receiverAddress: '0x73BB3FD47A67254635A86030c3Fd742219f155AB',
  chainId: 8453,
  chainName: 'Base',
  tokenSymbol: 'ETH',
  explorerBaseUrl: 'https://basescan.org/tx',
  activationMode: import.meta.env.VITE_PAYMENT_ACTIVATION_MODE || 'manual',

  plans: {
    free: {
      id: 'free',
      name: 'Free',
      priceUsdMonthly: 0,
      priceUsdAnnual: 0,
      durationDaysMonthly: 30,
      durationDaysAnnual: 365,
      features: [
        'Basic dashboard access',
        'Limited wallet checks',
        'Limited mint tracking',
        'Community beta access',
      ],
    },

    pro: {
      id: 'pro',
      name: 'Pro',
      priceUsdMonthly: 19,
      priceUsdAnnual: 190,
      durationDaysMonthly: 30,
      durationDaysAnnual: 365,
      features: [
        'Real-time whale alerts',
        'Telegram notifications',
        'Wallet forensics',
        'MintGuard access',
        'Automint tools',
        'More tracked wallets',
      ],
    },

    elite: {
      id: 'elite',
      name: 'Elite',
      priceUsdMonthly: 49,
      priceUsdAnnual: 490,
      durationDaysMonthly: 30,
      durationDaysAnnual: 365,
      features: [
        'Everything in Pro',
        'Priority alert speed',
        'Advanced wallet intelligence',
        'Multi-wallet tracking',
        'Premium AI forensic reports',
        'Early beta features',
      ],
    },
  },
}

export const PAID_PLAN_IDS = ['pro', 'elite']

export function getPlanPriceUsd(plan, billingCycle) {
  return billingCycle === 'annual' ? plan.priceUsdAnnual : plan.priceUsdMonthly
}

export function getPlanDurationDays(plan, billingCycle) {
  return billingCycle === 'annual' ? plan.durationDaysAnnual : plan.durationDaysMonthly
}

export function roundUpEthAmount(usdPrice, ethUsd) {
  if (!usdPrice || !ethUsd) return 0
  return Math.ceil((Number(usdPrice) / Number(ethUsd)) * 1_000_000) / 1_000_000
}
