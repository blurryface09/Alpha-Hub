const ZERO_ADDR = /^0x0+$/

export function detectCopySignals(activity, watchlist) {
  if (!activity?.length || !watchlist?.length) return []

  const cutoff = Date.now() - 24 * 60 * 60 * 1000

  // Build lookup from watchlist
  const watchSet  = new Set(watchlist.map(w => `${w.wallet_address.toLowerCase()}:${w.chain}`))
  const labelMap  = Object.fromEntries(
    watchlist.map(w => [`${w.wallet_address.toLowerCase()}:${w.chain}`, w.label])
  )

  // Only mints from watched wallets in the last 24 h with a real contract
  const relevant = activity.filter(a =>
    a.is_mint &&
    a.contract_address &&
    !ZERO_ADDR.test(a.contract_address) &&
    new Date(a.timestamp || a.created_at).getTime() > cutoff &&
    watchSet.has(`${(a.wallet_address || '').toLowerCase()}:${a.chain}`)
  )

  if (!relevant.length) return []

  // Group by contract + chain
  const groups = {}
  for (const a of relevant) {
    const key = `${a.contract_address.toLowerCase()}:${a.chain}`
    if (!groups[key]) {
      groups[key] = {
        contract_address: a.contract_address,
        chain: a.chain,
        wallets: [],
        _seen: new Set(),
        first_mint_at: a.timestamp || a.created_at,
        total_eth: 0,
      }
    }
    const g   = groups[key]
    const wlo = (a.wallet_address || '').toLowerCase()
    if (!g._seen.has(wlo)) {
      g._seen.add(wlo)
      g.wallets.push({ address: a.wallet_address, label: labelMap[`${wlo}:${a.chain}`] })
    }
    const ts = new Date(a.timestamp || a.created_at).getTime()
    if (ts < new Date(g.first_mint_at).getTime()) g.first_mint_at = a.timestamp || a.created_at
    g.total_eth += parseFloat(a.value_eth || 0)
  }

  return Object.values(groups)
    .map(({ _seen, ...g }) => ({
      ...g,
      total_eth: parseFloat(g.total_eth.toFixed(4)),
      // 1 wallet = Watch, 2 = Strong, 3+ = HOT
      signal_strength: g.wallets.length >= 3 ? 3 : g.wallets.length >= 2 ? 2 : 1,
    }))
    .sort((a, b) =>
      b.signal_strength !== a.signal_strength
        ? b.signal_strength - a.signal_strength
        : new Date(b.first_mint_at) - new Date(a.first_mint_at)
    )
}
