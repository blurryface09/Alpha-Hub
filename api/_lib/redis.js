import { Redis } from '@upstash/redis'

let redis

export function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null
  }

  if (!redis) redis = Redis.fromEnv()
  return redis
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown'
}

export async function rateLimit(key, limit = 20, windowSeconds = 60) {
  const client = getRedis()
  if (!client) {
    console.warn('Rate limit skipped: Upstash Redis env vars are not configured')
    return { allowed: true, remaining: limit, resetSeconds: windowSeconds }
  }

  let count
  try {
    count = await client.incr(key)
    if (count === 1) await client.expire(key, windowSeconds)
  } catch (error) {
    console.error('Rate limit skipped: Redis unavailable:', error.message)
    return { allowed: true, remaining: limit, resetSeconds: windowSeconds }
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(limit - count, 0),
    resetSeconds: windowSeconds,
  }
}

export function sendRateLimit(res, result) {
  res.setHeader('Retry-After', String(result.resetSeconds || 60))
  return res.status(429).json({ error: 'Too many requests' })
}

export async function cacheGet(key) {
  const client = getRedis()
  if (!client) return null
  try {
    return await client.get(key)
  } catch (error) {
    console.error('Redis cache read failed:', error.message)
    return null
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  const client = getRedis()
  if (!client) return
  try {
    await client.set(key, value, { ex: ttlSeconds })
  } catch (error) {
    console.error('Redis cache write failed:', error.message)
  }
}
