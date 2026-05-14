let cachedPrice = null
let cachedAt = 0

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const now = Date.now()
  if (cachedPrice && now - cachedAt < 60_000) {
    return res.status(200).json({
      ethUsd: cachedPrice,
      source: 'coingecko',
      updatedAt: new Date(cachedAt).toISOString(),
    })
  }

  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      headers: { accept: 'application/json' },
    })
    const data = await response.json()
    const ethUsd = Number(data?.ethereum?.usd)

    if (!response.ok || !Number.isFinite(ethUsd) || ethUsd <= 0) {
      throw new Error('Invalid ETH price response')
    }

    cachedPrice = ethUsd
    cachedAt = now
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    return res.status(200).json({
      ethUsd,
      source: 'coingecko',
      updatedAt: new Date(cachedAt).toISOString(),
    })
  } catch (error) {
    return res.status(503).json({
      error: 'ETH price temporarily unavailable',
      source: 'coingecko',
      updatedAt: new Date().toISOString(),
    })
  }
}
