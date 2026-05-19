import React, { useEffect, useState } from 'react'
import { Activity, Zap, Hash, Repeat2, TrendingUp } from 'lucide-react'
import { useWalletIntelStore } from '../../store'
import { convictionLabel, convictionColor } from '../../../worker/lib/wallet-intelligence.js'

function shortAddr(addr) {
  if (!addr) return ''
  return addr.slice(0, 10) + '…' + addr.slice(-4)
}

function StatBox({ icon: Icon, label, value, color = 'text-text' }) {
  return (
    <div className="bg-surface2 rounded-lg p-2.5 flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-muted">
        <Icon size={10} />
        <span className="text-[10px] uppercase tracking-wider font-mono">{label}</span>
      </div>
      <div className={`text-base font-bold ${color}`}>{value}</div>
    </div>
  )
}

function ConvictionBar({ score }) {
  const label = convictionLabel(score)
  const color = convictionColor(score)
  const pct   = Math.min(score, 100)

  const barColor =
    score >= 80 ? 'bg-green' :
    score >= 60 ? 'bg-accent' :
    score >= 40 ? 'bg-accent3' :
    score >= 20 ? 'bg-amber-400' : 'bg-muted'

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted uppercase tracking-wider font-mono">Conviction</span>
        <span className={`text-xs font-bold ${color}`}>{label} ({score}/100)</span>
      </div>
      <div className="h-1.5 bg-surface2 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function WalletIntelPanel({ address, chain = 'eth', label, recentActivity = [] }) {
  const { fetchProfile } = useWalletIntelStore()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!address) return
    setLoading(true)
    fetchProfile(address, chain).then(p => {
      setProfile(p)
      setLoading(false)
    })
  }, [address, chain, fetchProfile])

  const recentMints = recentActivity
    .filter(a => a.is_mint && a.wallet_address?.toLowerCase() === address?.toLowerCase())
    .slice(0, 5)

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Activity size={13} className="text-accent" />
        <span className="text-xs font-semibold">{label || shortAddr(address)}</span>
        <span className={`badge text-[10px] ${chain === 'eth' ? 'badge-purple' : 'badge-cyan'}`}>
          {chain.toUpperCase()}
        </span>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4 text-muted text-xs">
          <div className="spinner w-3 h-3" />
          Loading profile…
        </div>
      )}

      {!loading && !profile && (
        <p className="text-xs text-muted italic">
          No profile yet — data builds after the wallet mints something.
        </p>
      )}

      {!loading && profile && (
        <>
          <ConvictionBar score={profile.conviction_score} />

          <div className="grid grid-cols-2 gap-2">
            <StatBox icon={Zap}      label="Mints"     value={profile.total_mints}      color="text-green" />
            <StatBox icon={Hash}     label="Projects"  value={profile.unique_contracts}  color="text-accent" />
            <StatBox icon={TrendingUp} label="Large"   value={profile.large_mints}       color="text-accent3" />
            <StatBox icon={Repeat2}  label="Repeats"   value={profile.repeat_mints}      color="text-amber-400" />
          </div>

          {profile.last_active_at && (
            <p className="text-[10px] text-muted2">
              Last active: {new Date(profile.last_active_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </p>
          )}
        </>
      )}

      {/* Recent mints */}
      {recentMints.length > 0 && (
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wider font-mono mb-1.5">Recent mints</div>
          <div className="space-y-1">
            {recentMints.map((a, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <div className="dot-live w-1.5 h-1.5 flex-shrink-0" />
                <span className="font-mono text-muted truncate">
                  {a.contract_address ? a.contract_address.slice(0, 14) + '…' : a.method_name || 'mint'}
                </span>
                {parseFloat(a.value_eth || 0) > 0 && (
                  <span className="text-green ml-auto flex-shrink-0">
                    {parseFloat(a.value_eth).toFixed(3)} ETH
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
