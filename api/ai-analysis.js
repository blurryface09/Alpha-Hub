import { requireUser } from './_lib/auth.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const SYSTEM = `You are an expert on-chain forensics analyst and smart contract auditor for a professional crypto and NFT trading community. You have deep knowledge of DeFi protocols, DEX mechanics, NFT markets, MEV/sandwich attacks, rug pull patterns, and on-chain behavior analysis. You give structured forensic reports with clear section headers. You decode failed transactions precisely, identify bot behavior, jeet patterns, honeypots and contract backdoors. You write in direct crypto community language. No financial disclaimers. Ever.`

const LIMITS = {
  wallet: { maxTokens: 2048 },
  contract: { maxTokens: 2048 },
  whale: { maxTokens: 512 },
  project: { maxTokens: 1024 },
}

function cleanPrompt(value) {
  return String(value || '').slice(0, 12000)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const apiKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'AI key is not configured on the server' })

  const { type = 'wallet', prompt } = req.body || {}
  const limit = LIMITS[type]
  if (!limit) return res.status(400).json({ error: 'Unknown AI analysis type' })

  const content = cleanPrompt(prompt)
  if (!content) return res.status(400).json({ error: 'Prompt is required' })

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content },
        ],
        max_tokens: limit.maxTokens,
        temperature: type === 'project' ? 0.4 : 0.7,
      }),
    })

    const data = await upstream.json().catch(() => null)
    if (!upstream.ok || data?.error) {
      return res.status(upstream.ok ? 502 : upstream.status).json({
        error: data?.error?.message || 'AI provider request failed',
      })
    }

    return res.status(200).json({
      content: data?.choices?.[0]?.message?.content || 'Analysis unavailable.',
    })
  } catch (error) {
    return res.status(502).json({ error: error.message || 'AI provider unavailable' })
  }
}
