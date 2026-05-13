import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Shield, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import { getWalletData, getContractData, CHAINS, decodeMethodName } from '../lib/blockchain'
import { analyzeWallet, auditContract } from '../lib/ai'
import { useSubscription } from '../hooks/useSubscription'

const TABS = ['wallet', 'contract']

function renderAiText(text) {
  const lines = String(text || '').split('\n')
  return lines.map((line, lineIndex) => {
    const parts = line.split(/(\*\*.*?\*\*)/g).filter(Boolean)
    return (
      <React.Fragment key={lineIndex}>
        {parts.map((part, partIndex) => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={partIndex}>{part.slice(2, -2)}</strong>
          }
          return <React.Fragment key={partIndex}>{part}</React.Fragment>
        })}
        {lineIndex < lines.length - 1 ? <br /> : null}
      </React.Fragment>
    )
  })
}

export default function AlphaPage() {
  const { plan } = useSubscription()
  const [activeTab, setActiveTab] = useState('wallet')
  const [chain, setChain] = useState('eth')
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [walletData, setWalletData] = useState(null)
  const [contractData, setContractData] = useState(null)
  const [aiAnalysis, setAiAnalysis] = useState('')
  const [error, setError] = useState('')
  const [lastPrompt, setLastPrompt] = useState(null)
  const [lastType, setLastType] = useState(null)

  const handleAnalyze = async () => {
    if (!address || !address.startsWith('0x')) {
      toast.error('Enter a valid 0x address')
      return
    }
    setLoading(true)
    setAiAnalysis('')
    setWalletData(null)
    setContractData(null)
    setError('')
    try {
      if (activeTab === 'wallet') {
        const data = await getWalletData(address, chain)
        if (!data || !data.txs) throw new Error('No data returned — check your Etherscan API key')
        setWalletData(data)
        setLoading(false)
        setAiLoading(true)
        setLastType('wallet')
        try {
          const jLabel = data.jeetScore >= 75 ? 'Certified Jeet' : data.jeetScore >= 50 ? 'Flip Merchant' : data.jeetScore >= 25 ? 'Selective Seller' : 'Diamond Tendencies'
          const walletPayload = { address, chain: CHAINS[chain], ...data, jeetLabel: jLabel }
          setLastPrompt(walletPayload)
          const analysis = await analyzeWallet(walletPayload)
          setAiAnalysis(analysis)
        } catch (aiErr) {
          setAiAnalysis('AI analysis unavailable — ' + aiErr.message)
        }
      } else {
        const data = await getContractData(address, chain)
        if (!data) throw new Error('No contract data returned')
        setContractData(data)
        setLoading(false)
        setAiLoading(true)
        setLastType('contract')
        try {
          const contractPayload = { address, chain: CHAINS[chain], ...data }
          setLastPrompt(contractPayload)
          const analysis = await auditContract(contractPayload)
          setAiAnalysis(analysis)
        } catch (aiErr) {
          setAiAnalysis('AI analysis unavailable — ' + aiErr.message)
        }
      }
    } catch (err) {
      setError(err.message)
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

      <div className="card mb-4">
        <div className="flex gap-2 flex-wrap mb-4">
          <div className="flex bg-surface2 rounded-lg p-1">
            {TABS.map(t => (
              <button
                key={t}
                onClick={() => { setActiveTab(t); setWalletData(null); setContractData(null); setAiAnalysis(''); setError('') }}
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
                onClick={() => { setChain(key); setWalletData(null); setContractData(null); setAiAnalysis(''); setError('') }}
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
          <button onClick={handleAnalyze} disabled={loading} className="btn-primary flex items-center gap-2 whitespace-nowrap">
            {loading ? <div className="spinner w-3.5 h-3.5" /> : <Search size={14} />}
            Analyze
          </button>
        </div>
        {error && <p className="text-accent2 text-sm mt-2">⚠ {error}</p>}
      </div>

      {import.meta.env.DEV && plan === 'admin' && !walletData && !contractData && !loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
          {[
            { title: 'Wallet intelligence', body: 'Paste a wallet to classify behavior, risk, failed txs, and copy-trading suitability.' },
            { title: 'Contract readiness', body: 'Paste a contract to check verification, risk signals, launch readiness, and automint fit.' },
            { title: 'Confidence labels', body: 'Reports include data source, last updated, confidence level, and why confidence is limited.' },
          ].map((item) => (
            <div key={item.title} className="card border-accent/10 bg-accent/5">
              <div className="section-label">Local preview</div>
              <div className="text-sm font-semibold">{item.title}</div>
              <p className="text-xs text-muted mt-2">{item.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* Wallet Results */}
      {walletData && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: `${CHAINS[chain]?.symbol || 'ETH'} Balance`, val: walletData.bal || '0', color: 'text-accent' },
              { label: 'Total Txns', val: walletData.txs?.length || 0, color: 'text-text' },
              { label: 'Volume', val: `${walletData.volume || '0'} ${CHAINS[chain]?.symbol || 'ETH'}`, color: 'text-text' },
              { label: 'Gas Spent', val: `${walletData.gasSpent || '0'} ETH`, color: 'text-accent3' },
              { label: 'Failed Txns', val: walletData.failed || 0, color: (walletData.failed || 0) > 0 ? 'text-accent2' : 'text-text' },
              { label: 'Tokens', val: walletData.tokens?.length || 0, color: 'text-text' },
            ].map(m => (
              <div key={m.label} className="metric-card">
                <div className={`text-xl font-bold ${m.color}`}>{m.val}</div>
                <div className="section-label mt-1 mb-0">{m.label}</div>
              </div>
            ))}
          </div>

          {/* Jeet Score */}
          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <span className="section-label mb-0">Jeet Score</span>
              <span className={`text-sm font-bold ${jeetColor(walletData.jeetScore || 0)}`}>
                {walletData.jeetScore || 0}/100 — {jeetLabel(walletData.jeetScore || 0)}
              </span>
            </div>
            <div className="h-2 bg-surface2 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${walletData.jeetScore || 0}%` }}
                transition={{ duration: 0.8 }}
                className={`h-full rounded-full ${
                  (walletData.jeetScore || 0) >= 75 ? 'bg-accent2' :
                  (walletData.jeetScore || 0) >= 50 ? 'bg-accent3' :
                  (walletData.jeetScore || 0) >= 25 ? 'bg-text' : 'bg-green'
                }`}
              />
            </div>
          </div>

          {/* Token transfers */}
          {walletData.tokens?.length > 0 && (
            <div className="card">
              <div className="section-label">Token Transfers ({walletData.tokens.length})</div>
              {walletData.tokens.slice(0, 8).map((t, i) => {
                if (!t) return null
                const isOut = t.from?.toLowerCase() === address.toLowerCase()
                const decimals = parseInt(t.tokenDecimal) || 18
                const amt = (parseInt(t.value || '0') / Math.pow(10, decimals)).toFixed(2)
                return (
                  <div key={i} className="tx-row">
                    <div className="flex items-center gap-2">
                      <span className={`badge ${isOut ? 'badge-red' : 'badge-green'}`}>{isOut ? 'OUT' : 'IN'}</span>
                      <span className="badge badge-cyan">{t.tokenSymbol || 'TOKEN'}</span>
                      <span className="text-xs text-muted truncate max-w-24">{t.tokenName || ''}</span>
                    </div>
                    <span className={`text-sm font-mono font-medium ${isOut ? 'text-accent2' : 'text-green'}`}>
                      {isOut ? '-' : '+'}{parseFloat(amt).toLocaleString()}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Transactions */}
          {walletData.txs?.length > 0 && (
            <div className="card">
              <div className="section-label">Recent Transactions ({walletData.txs.length})</div>
              {walletData.txs.slice(0, 20).map((t, i) => {
                if (!t) return null
                const isOut = t.from?.toLowerCase() === address.toLowerCase()
                const val = t.value ? (parseInt(t.value) / 1e18).toFixed(4) : '0'
                const method = decodeMethodName(t.input?.slice(0, 10))
                const ts = t.timeStamp ? new Date(parseInt(t.timeStamp) * 1000) : null
                return (
                  <div key={i} className="tx-row">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`badge ${t.isError === '1' ? 'badge-red' : 'badge-green'}`}>
                          {t.isError === '1' ? 'FAILED' : 'OK'}
                        </span>
                        <span className={`badge ${isOut ? 'badge-red' : 'badge-green'}`}>{isOut ? 'OUT' : 'IN'}</span>
                        <span className="text-xs text-muted font-mono truncate max-w-32">{method}</span>
                      </div>
                      <div className="text-xs text-muted mt-1 font-mono">
                        {isOut ? `To: ${t.to?.slice(0,10) || '?'}...` : `From: ${t.from?.slice(0,10) || '?'}...`}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className={`text-sm font-medium ${isOut ? 'text-accent2' : 'text-green'}`}>
                        {isOut ? '-' : '+'}{val} {CHAINS[chain]?.symbol || 'ETH'}
                      </div>
                      <div className="text-xs text-muted">
                        {ts ? ts.toLocaleDateString() : '—'}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* AI */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="section-label mb-0">Forensic AI Analysis</div>
                <p className="text-[11px] text-muted mt-1">Source: on-chain data · Last updated now · Confidence shown in report</p>
              </div>
              {(aiAnalysis || aiLoading) && (
                <button
                  onClick={async () => {
                    if (!lastPrompt || aiLoading) return
                    setAiLoading(true)
                    setAiAnalysis('')
                    try {
                      const result = lastType === 'wallet'
                        ? await analyzeWallet(lastPrompt)
                        : await auditContract(lastPrompt)
                      setAiAnalysis(result)
                    } catch(e) { setAiAnalysis('Retry failed: ' + e.message) }
                    finally { setAiLoading(false) }
                  }}
                  disabled={aiLoading}
                  className="btn-ghost text-xs px-2 py-1 flex items-center gap-1.5"
                >
                  <RefreshCw size={11} className={aiLoading ? 'animate-spin' : ''} />
                  Retry AI
                </button>
              )}
            </div>
            {aiLoading ? (
              <div className="flex items-center gap-3 py-4 text-muted text-sm">
                <div className="spinner" />
                Running deep forensic analysis...
              </div>
            ) : aiAnalysis ? (
              <div className="ai-result text-sm leading-relaxed">
                {renderAiText(aiAnalysis)}
              </div>
            ) : null}
          </div>
        </motion.div>
      )}

      {/* Contract Results */}
      {contractData && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Contract Name', val: contractData.contractName || 'Unknown', color: 'text-text' },
              { label: 'Safety Score', val: `${contractData.score || 0}/100`, color: (contractData.score || 0) >= 70 ? 'text-green' : (contractData.score || 0) >= 40 ? 'text-accent3' : 'text-accent2' },
              { label: 'Verified', val: contractData.verified ? 'Yes' : 'No', color: contractData.verified ? 'text-green' : 'text-accent2' },
              { label: 'Unique Senders', val: contractData.unique || 0, color: 'text-text' },
              { label: 'Contract Age', val: `${contractData.age || 0}d`, color: (contractData.age || 0) > 14 ? 'text-green' : 'text-accent3' },
              { label: 'Fail Rate', val: `${contractData.failRate || 0}%`, color: (contractData.failRate || 0) > 20 ? 'text-accent2' : 'text-green' },
            ].map(m => (
              <div key={m.label} className="metric-card">
                <div className={`text-xl font-bold ${m.color}`}>{m.val}</div>
                <div className="section-label mt-1 mb-0">{m.label}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <span className="section-label mb-0">Safety Score</span>
              <span className={`text-sm font-bold ${(contractData.score || 0) >= 70 ? 'text-green' : (contractData.score || 0) >= 40 ? 'text-accent3' : 'text-accent2'}`}>
                {(contractData.score || 0) >= 70 ? 'LOWER RISK' : (contractData.score || 0) >= 40 ? 'CAUTION' : '⚠️ HIGH RISK'}
              </span>
            </div>
            <div className="h-2 bg-surface2 rounded-full overflow-hidden mb-4">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${contractData.score || 0}%` }}
                transition={{ duration: 0.8 }}
                className={`h-full rounded-full ${(contractData.score || 0) >= 70 ? 'bg-green' : (contractData.score || 0) >= 40 ? 'bg-accent3' : 'bg-accent2'}`}
              />
            </div>
            {contractData.signals?.filter(Boolean).map((s, i) => (
              <div key={i} className="signal-row">
                <span className="text-sm">{s.label}</span>
                <span className={`badge ${s.ok ? 'badge-green' : 'badge-red'}`}>{s.ok ? 'PASS' : 'FAIL'}</span>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="section-label mb-0">AI Security Audit</div>
                <p className="text-[11px] text-muted mt-1">Source: contract metadata + recent calls · Last updated now · Confidence shown in report</p>
              </div>
              {(aiAnalysis || aiLoading) && (
                <button
                  onClick={async () => {
                    if (!lastPrompt || aiLoading) return
                    setAiLoading(true)
                    setAiAnalysis('')
                    try {
                      const result = await auditContract(lastPrompt)
                      setAiAnalysis(result)
                    } catch(e) { setAiAnalysis('Retry failed: ' + e.message) }
                    finally { setAiLoading(false) }
                  }}
                  disabled={aiLoading}
                  className="btn-ghost text-xs px-2 py-1 flex items-center gap-1.5"
                >
                  <RefreshCw size={11} className={aiLoading ? 'animate-spin' : ''} />
                  Retry AI
                </button>
              )}
            </div>
            {aiLoading ? (
              <div className="flex items-center gap-3 py-4 text-muted text-sm">
                <div className="spinner" />
                Auditing contract...
              </div>
            ) : aiAnalysis ? (
              <div className="ai-result text-sm leading-relaxed">
                {renderAiText(aiAnalysis)}
              </div>
            ) : null}
          </div>
        </motion.div>
      )}
    </div>
  )
}
