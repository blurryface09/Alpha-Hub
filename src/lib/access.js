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
  whaleradar: 'pro',
  mintguard: 'pro',
  alpha: 'pro',
  automint: 'pro',
  telegram: 'pro',
  advancedReports: 'elite',
  priorityAlerts: 'elite',
  multiWallet: 'elite',
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

export function planLabel(plan) {
  if (plan === 'elite') return 'Elite'
  if (plan === 'pro') return 'Pro'
  return 'Free'
}
