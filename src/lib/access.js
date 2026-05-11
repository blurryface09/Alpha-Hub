export const PLAN_RANK = {
  free: 0,
  pro: 1,
  elite: 2,
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
  if (subscription?.status === 'active') return subscription.plan || 'pro'
  if (subscription?.status === 'free' || subscription?.plan === 'free') return 'free'
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
