import { requireUser } from '../_lib/auth.js'
import { rateLimit, sendRateLimit } from '../_lib/redis.js'
import { detectProject } from '../_lib/project-intelligence.js'

function cleanError() {
  return 'Project detection is temporarily unavailable. Paste the basics manually.'
}

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase()
  if (action !== 'detect-project') return res.status(404).json({ ok: false, error: 'Unknown intelligence action' })
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const limited = await rateLimit(`rl:intel-detect:${user.id}`, 30, 60)
  if (!limited.allowed) return sendRateLimit(res, limited)

  try {
    const result = await detectProject(req.body || {})
    return res.status(200).json(result)
  } catch (error) {
    console.error('detect-project failed:', error)
    return res.status(200).json({ ok: false, error: cleanError() })
  }
}
