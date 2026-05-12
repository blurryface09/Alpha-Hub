export const PLAN_RANK = {
  free: 0,
  weekly: 0,
  pro: 1,
  monthly: 1,
  elite: 2,
  quarterly: 2,
  founder: 2,
}

export const FEATURE_ACCESS = {
  overview: 'free',
  settings: 'free',
  whaleradar: 'free',
  mintguard: 'free',
  alpha: 'pro',
  automint: 'pro',
  telegram: 'pro',
  advancedReports: 'elite',
  priorityAlerts: 'elite',
  multiWallet: 'elite',
}

export const PLAN_LIMITS = {
  free: {
    trackedWallets: 1,
    mintProjects: 1,
    walletChecksPerDay: 3,
    aiReportsPerDay: 0,
  },
  pro: {
    trackedWallets: 10,
    mintProjects: 15,
    walletChecksPerDay: 50,
    aiReportsPerDay: 20,
  },
  elite: {
    trackedWallets: 50,
    mintProjects: 100,
    walletChecksPerDay: 250,
    aiReportsPerDay: 100,
  },
}

export function normalizedPlan(subscription) {
  if (subscription?.status === 'active') {
    if (subscription.plan === 'quarterly' || subscription.plan === 'founder' || subscription.plan === 'elite') return 'elite'
    if (subscription.plan === 'monthly' || subscription.plan === 'pro') return 'pro'
    return 'free'
  }
  if (subscription?.status === 'free' || subscription?.plan === 'free' || subscription?.plan === 'weekly') return 'free'
  return null
}

export function hasPlanAccess(subscription, requiredPlan = 'free') {
  const current = normalizedPlan(subscription)
  if (!current) return false
  return (PLAN_RANK[current] ?? -1) >= (PLAN_RANK[requiredPlan] ?? 0)
}

export function planLimits(plan = 'free') {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free
}

export function planLabel(plan) {
  if (plan === 'elite') return 'Elite'
  if (plan === 'pro') return 'Pro'
  return 'Free'
}
