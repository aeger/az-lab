'use client'

import { useEffect, useState } from 'react'
import type { AdGuardStats } from '@/lib/adguard'

export default function NetworkStats() {
  const [stats, setStats] = useState<AdGuardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'overview' | 'domains' | 'clients'>('overview')

  useEffect(() => {
    fetch('/api/dns')
      .then((r) => r.json())
      .then((d) => d.error ? setStats(null) : setStats(d))
      .catch(() => {})
      .finally(() => setLoading(false))

    const interval = setInterval(() => {
      fetch('/api/dns')
        .then((r) => r.json())
        .then((d) => d.error ? null : setStats(d))
        .catch(() => {})
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
    </div>
  )

  if (!stats) return (
    <div className="text-zinc-500 text-sm text-center py-6">AdGuard not configured</div>
  )

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${stats.protection_enabled ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-xs text-zinc-400">
            {stats.protection_enabled ? 'Protection Active' : 'Protection Off'}
          </span>
        </div>
        <span className="text-xs text-zinc-600">
          {stats.num_filter_lists} lists &middot; {formatNum(stats.num_rules)} rules
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Queries / 24h" value={formatNum(stats.total_dns_queries)} />
        <StatCard label="Blocked" value={`${formatNum(stats.blocked_filtering)}`} sub={`${stats.blocked_percent}%`} color="text-red-400" />
        <StatCard label="Avg Response" value={`${stats.avg_processing_time_ms}ms`} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {(['overview', 'domains', 'clients'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-2 py-1 transition-colors ${tab === t ? 'text-zinc-200 border-b border-zinc-400' : 'text-zinc-500 hover:text-zinc-400'}`}
          >
            {t === 'overview' ? 'Top Queried' : t === 'domains' ? 'Top Blocked' : 'Top Clients'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-0.5">
        {tab === 'overview' && stats.top_queried_domains.map((d, i) => (
          <ListRow key={i} name={d.name} value={formatNum(d.count)} />
        ))}
        {tab === 'domains' && stats.top_blocked_domains.map((d, i) => (
          <ListRow key={i} name={d.name} value={formatNum(d.count)} color="text-red-400" />
        ))}
        {tab === 'clients' && stats.top_clients.map((c, i) => (
          <ListRow key={i} name={c.name} value={formatNum(c.count)} />
        ))}
        {tab === 'overview' && stats.top_queried_domains.length === 0 && <Empty />}
        {tab === 'domains' && stats.top_blocked_domains.length === 0 && <Empty />}
        {tab === 'clients' && stats.top_clients.length === 0 && <Empty />}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-zinc-800/50 rounded-lg p-2 text-center">
      <div className={`text-lg font-semibold ${color ?? 'text-white'}`}>
        {value}
        {sub && <span className="text-xs font-normal text-zinc-500 ml-1">{sub}</span>}
      </div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  )
}

function ListRow({ name, value, color }: { name: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between text-xs py-0.5 px-1 rounded hover:bg-zinc-800/40">
      <span className="text-zinc-300 truncate">{name}</span>
      <span className={`ml-2 flex-shrink-0 ${color ?? 'text-zinc-500'}`}>{value}</span>
    </div>
  )
}

function Empty() {
  return <div className="text-xs text-zinc-600 text-center py-2">No data</div>
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
