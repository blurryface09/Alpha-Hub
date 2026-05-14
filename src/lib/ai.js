import { getAuthToken } from './supabase'

async function callAI(type, prompt) {
  const token = await getAuthToken()
  if (!token) return 'Sign in again to use AI analysis.'
  try {
    const r = await fetch('/api/ai-analysis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type, prompt }),
    })
    const d = await r.json()
    if (!r.ok || d.error) return `AI error: ${d.error || 'Request failed'}`
    return d.content || 'Analysis unavailable.'
  } catch(e) {
    return `AI unavailable: ${e.message}`
  }
}

export async function analyzeWallet({ address, chain, bal, txs, tokens, internals, jeetScore, jeetLabel, volume, gasSpent, tokenBuys, tokenSells, quickFlips, totalBought }) {
  const failedTxs = txs.filter(t => t.isError === '1')
  const firstTx = txs.length ? new Date(parseInt(txs[txs.length - 1].timeStamp) * 1000).toLocaleDateString() : '—'
  const lastTx = txs.length ? new Date(parseInt(txs[0].timeStamp) * 1000).toLocaleDateString() : '—'

  const methodNames = {
    '0xa9059cbb': 'transfer()', '0x095ea7b3': 'approve()',
    '0x38ed1739': 'DEX swap sell', '0x7ff36ab5': 'DEX buy ETH→token',
    '0x18cbafe5': 'DEX sell token→ETH', '0x40993b26': 'mint()',
    '0x1249c58b': 'mint()', '0xa22cb465': 'setApprovalForAll()',
    '0x715018a6': 'renounceOwnership()', '0x3ccfd60b': 'withdrawAll()',
  }

  const failedContext = failedTxs.slice(0, 5).map(t => {
    const method = methodNames[t.input?.slice(0, 10)] || t.input?.slice(0, 10) || '0x'
    const gasWasted = ((parseInt(t.gasUsed || 0) * parseInt(t.gasPrice || 0)) / 1e18).toFixed(6)
    return `  • ${method} — gas wasted: ${gasWasted} ETH — ${new Date(parseInt(t.timeStamp) * 1000).toLocaleDateString()}`
  }).join('\n')

  const tokenActivity = Object.entries(tokenBuys).slice(0, 8)
    .map(([sym, buys]) => `${sym}: bought ${buys}x, sold ${tokenSells[sym] || 0}x`).join(', ')

  const recentPattern = txs.slice(0, 10).map(t => {
    const isOut = t.from.toLowerCase() === address.toLowerCase()
    const val = (parseInt(t.value) / 1e18).toFixed(4)
    const method = methodNames[t.input?.slice(0, 10)] || (t.input && t.input !== '0x' ? 'contract call' : 'transfer')
    const failed = t.isError === '1' ? '[FAILED] ' : ''
    return `  ${failed}${isOut ? 'OUT' : 'IN'} ${val} ${chain.symbol} via ${method}`
  }).join('\n')

  const prompt = `WALLET FORENSIC REPORT REQUEST

WALLET: ${address}
CHAIN: ${chain.name}
BALANCE: ${bal} ${chain.symbol}
ACTIVE: ${firstTx} → ${lastTx}
TRANSACTIONS: ${txs.length} total | ${txs.filter(t => t.from.toLowerCase() === address.toLowerCase()).length} sent | ${txs.filter(t => t.to?.toLowerCase() === address.toLowerCase()).length} received | ${failedTxs.length} FAILED
VOLUME: ${volume} ${chain.symbol}
GAS SPENT: ${gasSpent} ${chain.symbol}
JEET SCORE: ${jeetScore}/100 — ${jeetLabel}
TOKEN FLIPS: ${quickFlips} of ${totalBought} tokens sold back
TOKEN ACTIVITY: ${tokenActivity || 'none'}
INTERNAL TXS: ${internals.length}

RECENT ACTIVITY:
${recentPattern}

FAILED TRANSACTIONS:
${failedContext || 'None'}

Write a forensic report with EXACTLY these sections and concrete signals only:

**WALLET SUMMARY**
Age window, tx count, chains used, volume, activity pattern, and likely user type: collector / sniper / deployer / trader / inactive wallet / bot-like wallet.

**RISK SCORE**
0-100 with label Low Risk / Medium Risk / High Risk / Unknown. Explain the score in one sentence.

**BEHAVIORAL SIGNALS**
Recent activity velocity, repeated contract interactions, failed tx rate, NFT mint frequency, token swap frequency, gas aggression, interaction diversity, and funding clues if visible.

**RED FLAGS**
Specific risks only: fresh high-value activity, failed tx rate, risky contracts, suspicious funding, concentration, bot-like timing, unknown deployer interaction.

**GREEN FLAGS**
Specific positives only: wallet age, diversified activity, verified marketplace interactions, low failed tx rate, organic history.

**ACTIONABLE RECOMMENDATION**
Pick one: Safe to monitor / Track but do not auto-copy / Avoid automint without manual review / High-confidence smart wallet candidate. Add one reason.

**CONFIDENCE**
High / Medium / Low with reason. Mention data source: on-chain transaction data from ${chain.name}, last updated now.

No vague DYOR filler. Max 450 words.`

  return callAI('wallet', prompt)
}

// --- Contract Security Audit -------------------------------------
export async function auditContract({ address, chain, contractName, verified, compiler, proxy, age, unique, txs, failRate, score, sourceCode }) {
  const recentCalls = txs.slice(0, 8).map(t => {
    const methodNames = {
      '0xa9059cbb': 'transfer', '0x095ea7b3': 'approve',
      '0x40993b26': 'mint', '0x1249c58b': 'mint',
      '0xa22cb465': 'setApprovalForAll', '0x42842e0e': 'safeTransferFrom',
      '0x715018a6': 'renounceOwnership', '0xf2fde38b': 'transferOwnership',
      '0x3ccfd60b': '⚠️ withdrawAll',
    }
    const method = methodNames[t.input?.slice(0, 10)] || t.input?.slice(0, 10) || 'transfer'
    return `  ${t.isError === '1' ? '[FAILED] ' : ''}${method} by ${t.from?.slice(0, 12)}...`
  }).join('\n')

  const srcSnippet = sourceCode ? sourceCode.slice(0, 4000) : null

  const prompt = `SMART CONTRACT SECURITY AUDIT

CONTRACT: ${address}
CHAIN: ${chain.name}
NAME: ${contractName}
VERIFIED: ${verified}
COMPILER: ${compiler}
PROXY: ${proxy}
AGE: ${age} days
UNIQUE SENDERS: ${unique}
TRANSACTIONS: ${txs.length}
FAIL RATE: ${failRate}%
SAFETY SCORE: ${score}/100

RECENT CONTRACT CALLS:
${recentCalls || 'No transactions yet'}

${srcSnippet ? `CONTRACT SOURCE CODE (first 4000 chars):
\`\`\`solidity
${srcSnippet}
\`\`\`
READ THE CODE for: hidden mint functions, owner withdraw backdoors, blacklist/pause mechanisms, renouncement status, fee traps, honeypot patterns.` : 'SOURCE CODE: NOT VERIFIED — treat as major red flag'}

Write an audit with EXACTLY these sections:

**CONTRACT INTELLIGENCE**
Verified status, likely type, chain, owner/deployer clues if visible, supply/max supply if visible, mint price/start time if visible, and marketplace presence if inferable.

**RISK SIGNALS**
List concrete risks: unverified source, owner pause/price control, suspicious mint function, no supply cap, no launch time, low holder diversity, high fail rate.

**LAUNCH READINESS**
Choose one: Ready to track / Needs manual review / Unsafe for Strike Mode. Explain why.

**AUTOMINT RECOMMENDATION**
Choose one: Safe Mint recommended / Strike Mode not recommended / Strike Mode allowed after user confirmation / Missing required data.

**TRANSACTION PATTERN**
What recent calls reveal: minting, transfers, approvals, failed interactions, or quiet contract.

**CONFIDENCE**
High / Medium / Low with reason. Mention data source: contract metadata and recent on-chain calls from ${chain.name}, last updated now.

No vague DYOR filler. Max 400 words.`

  return callAI('contract', prompt)
}

// --- Whale Activity Summary --------------------------------------
export async function summarizeWhaleMove({ label, address, chain, txHash, value, methodName, contractAddress, isMint }) {
  const prompt = `A whale wallet just moved on-chain. Give a 2-sentence sharp analysis for a crypto community feed.

WHALE: ${label || address.slice(0, 12) + '...'}
CHAIN: ${chain}
ACTION: ${methodName}
VALUE: ${value} ETH
CONTRACT: ${contractAddress || 'N/A'}
IS MINT: ${isMint}
TX: ${txHash}

If it's a mint, explain why this matters (new project, following smart money, etc).
If it's a large trade, explain what it signals (bullish, bearish, accumulation, distribution).
Keep it sharp, 2 sentences max. Crypto slang welcome.`

  return callAI('whale', prompt)
}

// --- Project Metadata from URL -----------------------------------
export async function extractProjectMetadata(url) {
  const prompt = `A user pasted this URL for an NFT/crypto project: ${url}

Based on the URL alone, extract and return ONLY a JSON object (no markdown, no explanation) with:
{
  "name": "project name if obvious from URL, else null",
  "source_type": "twitter" or "opensea" or "website",
  "chain": "eth" or "base" or "unknown",
  "notes": "one sentence about what this likely is"
}

Return only valid JSON.`

  try {
    const result = await callAI('project', prompt)
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
  } catch {}
  return { name: null, source_type: 'website', chain: 'eth', notes: null }
}

export async function fetchProjectIntel(project) {
  const prompt = `You are a crypto/NFT project researcher. Research this NFT project.

Project: ${project.name}
Source URL: ${project.source_url || 'unknown'}
WL Type: ${project.wl_type}
Chain: ${project.chain}
Mint Date: ${project.mint_date || 'not set'}
Notes: ${project.notes || 'none'}

Respond with ONLY valid JSON, no markdown:
{"summary":"2 sentence execution-focused description","wl_giveaway_likely":false,"giveaway_note":"","red_flags":[],"green_flags":[],"hype_score":5,"hype_reason":"one sentence","mint_interest_label":"Low/Medium/High","launch_readiness":"Ready to track/Needs manual review/Unsafe for Strike Mode","automint_recommendation":"Safe Mint recommended/Strike Mode not recommended/Strike Mode allowed after user confirmation/Missing required data","confidence":"Low/Medium/High","confidence_reason":"one sentence","advice":"one sharp action","discord_tip":"what to verify","twitter_tip":"search terms for X"}`

  try {
    const text = await callAI('project', prompt)
    if (text.startsWith('AI error:') || text.startsWith('AI unavailable:')) return { error: text }
    const clean = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/^[^{]*/s, '')
      .trim()
    const jsonMatch = clean.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0])
      } catch {
        const fixed = jsonMatch[0]
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
        return JSON.parse(fixed)
      }
    }
    return {
      summary: text.slice(0, 300),
      hype_score: 5,
      advice: text.slice(0, 150),
      red_flags: [],
      green_flags: [],
      wl_giveaway_likely: false,
      giveaway_note: '',
      hype_reason: '',
      discord_tip: '',
      twitter_tip: '',
    }
  } catch (e) {
    return { error: e.message }
  }
}
