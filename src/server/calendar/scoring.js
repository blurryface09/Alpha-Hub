export function scoreProject(project) {
  const mintCount = Number(project.mint_count || 0)
  const holders = Number(project.holder_count || 0)
  const tracked = Number(project.tracked_wallet_count || 0)
  const risk = Number(project.risk_score ?? 45)
  const hasContract = Boolean(project.contract_address)
  const hasImage = Boolean(project.image_url)
  const hasMintTime = Boolean(project.mint_date)

  const recencyScore = project.first_seen_at
    ? Math.max(0, 20 - Math.floor((Date.now() - new Date(project.first_seen_at).getTime()) / 36e5))
    : 0
  const proximityScore = project.mint_date
    ? Math.max(0, 24 - Math.abs(Math.floor((new Date(project.mint_date).getTime() - Date.now()) / 36e5)))
    : 0

  const hype_score = Math.min(100,
    Number(project.hype_score || 0) +
    Math.min(20, mintCount * 2) +
    tracked * 15 +
    Math.min(20, Math.floor(holders / 25)) +
    proximityScore +
    (hasImage ? 5 : 0)
  )

  const whale_interest_score = Math.min(100,
    Number(project.whale_interest_score || 0) +
    tracked * 20 +
    Math.min(25, mintCount * 2)
  )

  const hidden_gem_score = Math.min(100,
    Number(project.hidden_gem_score || 0) +
    recencyScore +
    (hasContract ? 15 : 0) +
    (hasMintTime ? 10 : 0) +
    (hype_score < 45 ? 20 : 0) -
    (risk > 65 ? 20 : 0)
  )

  const risk_score = Math.max(0, Math.min(100,
    Number.isFinite(project.risk_score)
      ? project.risk_score
      : 55 - (hasContract ? 10 : 0) - (hasImage ? 5 : 0) + (hasMintTime ? 0 : 10)
  ))

  return {
    ...project,
    hype_score: Math.round(hype_score),
    whale_interest_score: Math.round(whale_interest_score),
    hidden_gem_score: Math.round(hidden_gem_score),
    risk_score: Math.round(risk_score),
  }
}
