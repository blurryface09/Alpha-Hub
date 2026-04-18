const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`

const SYSTEM = `You are an expert on-chain forensics analyst and smart contract auditor for a professional crypto and NFT trading community. You have deep knowledge of DeFi protocols, DEX mechanics, NFT markets, MEV/sandwich attacks, rug pull patterns, and on-chain behavior analysis. You give structured forensic reports with clear section headers. You decode failed transactions precisely, identify bot behavior, jeet patterns, honeypots and contract backdoors. You write in direct crypto community language. No financial disclaimers. Ever.`

async function callGemini(prompt) {
  const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM + '\n\n' + prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error.message)
  return d.candidates?.[0]?.content?.parts?.[0]?.text || 'Analysis unavailable.'
}

// ─── Wallet Forensic Analysis ────────────────────────────────────
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

Write a forensic report with EXACTLY these sections:

**VERDICT**
One line classification: whale / degen / jeet / diamond hands / bot / normie / rug deployer. One sentence why.

**BEHAVIOR PATTERN**
What does this wallet actually do? Which protocols, which strategies, how they move money. Specific.

**JEET ANALYSIS**
Based on ${jeetScore}/100 score and token activity. Do they dump early? Hold through dips? Evidence from data.

**FAILED TX FORENSICS**
Explain each failed tx in plain English. Was it bad slippage? Sandwich attack? Honeypot trap? Gas too low? Out-competed? If none, say so.

**RED FLAGS**
Any suspicious patterns, bot-like regularity, rug connections, wash trading, or anything the community must know.

**BOTTOM LINE**
One punchy sentence: trust this wallet, copy their moves, or stay away?

Max 400 words. Be direct. Crypto language.`

  return callGemini(prompt)
}

// ─── Contract Security Audit ─────────────────────────────────────
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

**VERDICT**
SAFE / CAUTION / HARD AVOID — one sentence biggest reason.

**WHAT THIS CONTRACT DOES**
Plain English: token, NFT, DEX, vault? What's its purpose?

**CODE VULNERABILITIES**
${srcSnippet ? 'List dangerous functions found: owner drain, hidden mint, blacklist, pause, fee manipulation. Quote function names.' : 'Explain unverified contract risks in detail.'}

**OWNERSHIP & CONTROL**
Renounced or not? What can the deployer still do? Rug risk level.

**TRANSACTION PATTERN**
What do recent calls reveal? Normal activity or suspicious?

**COMMUNITY VERDICT**
One sentence: ape in, proceed careful, or hard avoid?

Max 350 words. Direct. No fluff.`

  return callGemini(prompt)
}

// ─── Whale Activity Summary ──────────────────────────────────────
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

  return callGemini(prompt)
}

// ─── Project Metadata from URL ───────────────────────────────────
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
    const result = await callGemini(prompt)
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
  } catch {}
  return { name: null, source_type: 'website', chain: 'eth', notes: null }
}
