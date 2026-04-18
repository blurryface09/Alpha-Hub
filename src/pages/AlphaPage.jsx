import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Shield, ChevronRight, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { getWalletData, getContractData, CHAINS, decodeMethodName } from '../lib/blockchain'
import { analyzeWallet, auditContract } from '../lib/ai'

const TABS = ['wallet', 'contract']

export default function AlphaPage() {
  const [activeTab, setActiveTab] = useState('wallet')
  const [chain, setChain] = useState('eth')
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [walletData, setWalletData] = useState(null)
  const [contractData, setContractData] = useState(null)
  const [aiAnalysis, setAiAnalysis] = useState('')

  const handleAnalyze = async () => {
    if (!address || !address.startsWith('0x')) {
      toast.error('Enter a valid 0x address')
      return
    }
    setLoading(true)
    setAiAnalysis('')
    setWalletData(null)
    setContractData(null)
    try {
      if (activeTab === 'wallet') {
        const data = await getWalletData(address, chain)
        setWalletData(data)
        setLoading(false)
        // AI analysis async
        setAiLoading(true)
        const jeetLabel = data.jeetScore >= 75 ? 'Certified Jeet' : data.jeetScore >= 50 ? 'Flip Merchant' : data.jeetScore >= 25 ? 'Selective Seller' : 'Diamond Tendencies'
        const analysis = await analyzeWallet({ address, chain: CHAINS[chain], ...data, jeetLabel })
        setAiAnalysis(analysis)
      } else {
        const data = await getContractData(address, chain)
        setContractData(data)
        setLoading(false)
        setAiLoading(true)
        const analysis = await auditContract({ address, chain: CHAINS[chain], ...data })
        setAiAnalysis(analysis)
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
      setAiLoading(false)
    }
  }

  const jeetColor = (score) => score >= 75 ? 'text-accent2' : score >= 50 ? 'text-accent3' : score >= 25 ? 'text-text' : 'text-green'
  const jeetLabel = (score) => score >= 75 ? 'Certified Jeet' : score >= 50 ? 'Flip Merchant' : score >= 25 ? 'Selective Seller' : 'Diamond Tendencies'

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Search size={20} className="text-accent" />
        <h1 className="text-xl font-bold">Alpha Tools</h1>
      </div>
      <p className="text-sm text-muted mb-6">Forensic wallet analysis and smart contract auditing.</p>

      {/* Mode + Chain selector */}
      <div className="card mb-4">
        <div className="flex gap-2 flex-wrap mb-4">
          <div className="flex bg-surface2 rounded-lg p-1">
            {TABS.map(t => (
              <button
                key={t}
                onClick={() => { setActiveTab(t); setWalletData(null); setContractData(null); setAiAnalysis('') }}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
                  activeTab === t ? 'bg-surface text-accent border border-border2' : 'text-muted'
                }`}
              >
                {t === 'wallet' ? '🔍 Wallet' : '🛡️ Contract'}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {Object.entries(CHAINS).map(([key, ch]) => (
              <button
                key={key}
                onClick={() => setChain(key)}
                className={`px-3 py-1.5 text-xs font-mono rounded-lg border transition-all ${
                  chain === key ? 'border-accent text-accent bg-accent/8' : 'border-border2 text-muted hover:text-text'
                }`}
              >
                {ch.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <input
            className="input"
            placeholder={activeTab === 'wallet' ? 'Enter wallet address (0x...)' : 'Enter contract address (0x...)'}
            value={address}
            onChange={e => setAddress(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
          />
          <button
            onClick={handleAnalyze}
            disabled={loading}
            className="btn-primary flex items-center gap-2 whitespace-nowrap"
          >
            {loading ? <div className="spinner w-3.5 h-3.5" /> : <Search size={14} />}
            Analyze
          </button>
        </div>
      </div>

      {/* Wallet Results */}
      <AnimatePresence>
        {walletData && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            {/* Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: `${CHAINS[chain].symbol} Balance`, val: walletData.bal, color: 'text-accent' },
                { label: 'Total Txns', val: walletData.txs.length, color: 'text-text' },
                { label: 'Volume', val: `${walletData.volume} ${CHAINS[chain].symbol}`, color: 'text-text' },
                { label: 'Gas Spent', val: `${walletData.gasSpent} ETH`, color: 'text-accent3' },
                { label: 'Failed Txns', val: walletData.failed, color: walletData.failed > 0 ? 'text-accent2' : 'text-text' },
              ].map(m => (
                <div key={m.label} className="metric-card">
                  <div className={`text-xl font-bold ${m.color}`}>{m.val}</div>
                  <div className="section-label mt-1 mb-0">{m.label}</div>
                </div>
              ))}
            </div>

            {/* Jeet Score Bar */}
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <span className="section-label mb-0">Jeet Score</span>
                <span className={`text-sm font-bold ${jeetColor(walletData.jeetScore)}`}>
                  {walletData.jeetScore}/100 — {jeetLabel(walletData.jeetScore)}
                </span>
              </div>
              <div className="h-2 bg-surface2 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${walletData.jeetScore}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                  className={`h-full rounded-full ${
                    walletData.jeetScore >= 75 ? 'bg-accent2' :
                    walletData.jeetScore >= 50 ? 'bg-accent3' :
                    walletData.jeetScore >= 25 ? 'bg-text' : 'bg-green'
                  }`}
                />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-xs text-green">Diamond</span>
                <span className="text-xs text-accent2">Jeet</span>
              </div>
            </div>

            {/* Token activity */}
            {walletData.tokens.length > 0 && (
              <div className="card">
                <div className="section-label">Token Transfers ({walletData.tokens.length})</div>
                <div className="space-y-0">
                  {walletData.tokens.slice(0, 10).map((t, i) => {
                    const isOut = t.from.toLowerCase() === address.toLowerCase()
                    const amt = t.tokenDecimal ? (parseInt(t.value) / Math.pow(10, parseInt(t.tokenDecimal))).toFixed(2) : t.value
                    return (
                      <div key={i} className="tx-row">
                        <div className="flex items-center gap-2">
                          <span className={`badge ${isOut ? 'badge-red' : 'badge-green'}`}>{isOut ? 'OUT' : 'IN'}</span>
                          <span className="badge badge-cyan">{t.tokenSymbol || 'TOKEN'}</span>
                          <span className="text-xs text-muted">{t.tokenName}</span>
                        </div>
                        <span className={`text-sm font-mono font-medium ${isOut ? 'text-accent2' : 'text-green'}`}>
                          {isOut ? '-' : '+'}{parseFloat(amt).toLocaleString()}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Transactions */}
            <div className="card">
              <div className="section-label">Recent Transactions ({walletData.txs.length})</div>
              <div className="space-y-0">
                {walletData.txs.slice(0, 20).map((t, i) => {
                  const isOut = t.from.toLowerCase() === address.toLowerCase()
                  const val = (parseInt(t.value) / 1e18).toFixed(4)
                  const method = decodeMethodName(t.input?.slice(0, 10))
                  return (
                    <div key={i} className="tx-row">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`badge ${t.isError === '1' ? 'badge-red' : 'badge-green'}`}>
                            {t.isError === '1' ? 'FAILED' : 'OK'}
                          </span>
                          <span className={`badge ${isOut ? 'badge-red' : 'badge-green'}`}>{isOut ? 'OUT' : 'IN'}</span>
                          <span className="text-xs text-muted font-mono truncate">{method}</span>
                        </div>
                        <div className="text-xs text-muted mt-1 font-mono">
                          {isOut ? `To: ${t.to?.slice(0,12)}...` : `From: ${t.from?.slice(0,12)}...`}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className={`text-sm font-medium ${isOut ? 'text-accent2' : 'text-green'}`}>
                          {isOut ? '-' : '+'}{val} {CHAINS[chain].symbol}
                        </div>
                        <div className="text-xs text-muted">
                          {new Date(parseInt(t.timeStamp) * 1000).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* AI Analysis */}
            <div className="card">
              <div className="section-label">Forensic AI Analysis</div>
              {aiLoading ? (
                <div className="flex items-center gap-3 py-4 text-muted text-sm">
                  <div className="spinner" />
                  Running deep forensic analysis...
                </div>
              ) : aiAnalysis ? (
                <div
                  className="ai-result"
                  dangerouslySetInnerHTML={{
                    __html: aiAnalysis
                      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                      .replace(/\n/g, '<br/>')
                  }}
                />
              ) : null}
            </div>
          </motion.div>
        )}

        {/* Contract Results */}
        {contractData && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: 'Contract Name', val: contractData.contractName, color: 'text-text' },
                { label: 'Safety Score', val: `${contractData.score}/100`, color: contractData.score >= 70 ? 'text-green' : contractData.score >= 40 ? 'text-accent3' : 'text-accent2' },
                { label: 'Verified', val: contractData.verified ? 'Yes' : 'No', color: contractData.verified ? 'text-green' : 'text-accent2' },
                { label: 'Unique Senders', val: contractData.unique, color: 'text-text' },
                { label: 'Contract Age', val: `${contractData.age}d`, color: contractData.age > 14 ? 'text-green' : 'text-accent3' },
                { label: 'Fail Rate', val: `${contractData.failRate}%`, color: contractData.failRate > 20 ? 'text-accent2' : 'text-green' },
              ].map(m => (
                <div key={m.label} className="metric-card">
                  <div className={`text-xl font-bold ${m.color}`}>{m.val}</div>
                  <div className="section-label mt-1 mb-0">{m.label}</div>
                </div>
              ))}
            </div>

            {/* Risk bar */}
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <span className="section-label mb-0">Safety Score</span>
                <span className={`text-sm font-bold ${contractData.score >= 70 ? 'text-green' : contractData.score >= 40 ? 'text-accent3' : 'text-accent2'}`}>
                  {contractData.score >= 70 ? 'LOWER RISK' : contractData.score >= 40 ? 'CAUTION' : '⚠️ HIGH RISK'}
                </span>
              </div>
              <div className="h-2 bg-surface2 rounded-full overflow-hidden mb-4">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${contractData.score}%` }}
                  transition={{ duration: 0.8 }}
                  className={`h-full rounded-full ${contractData.score >= 70 ? 'bg-green' : contractData.score >= 40 ? 'bg-accent3' : 'bg-accent2'}`}
                />
              </div>
              <div className="space-y-0">
                {contractData.signals.map((s, i) => (
                  <div key={i} className="signal-row">
                    <span className="text-sm">{s.label}</span>
                    <span className={`badge ${s.ok ? 'badge-green' : 'badge-red'}`}>{s.ok ? 'PASS' : 'FAIL'}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* AI Audit */}
            <div className="card">
              <div className="section-label">AI Security Audit</div>
              {aiLoading ? (
                <div className="flex items-center gap-3 py-4 text-muted text-sm">
                  <div className="spinner" />
                  Auditing contract...
                </div>
              ) : aiAnalysis ? (
                <div
                  className="ai-result"
                  dangerouslySetInnerHTML={{
                    __html: aiAnalysis
                      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                      .replace(/\n/g, '<br/>')
                  }}
                />
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
