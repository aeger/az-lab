'use client'

import { useEffect, useState } from 'react'

interface Finding {
  id: string
  category: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  recommendation?: string
}

interface SecurityData {
  scanned_at: string
  score: number
  findings: Finding[]
  stats: {
    ssh_failures_24h: number
    root_login_attempts_24h: number
    active_sessions: number
    privileged_containers: number
    failed_services: number
    updates_available: number
    disk_percent: number
    container_count: number
    game_server_ip: string
    game_open_ports: number[]
    game_services: Record<number, string>
  }
  counts: { critical: number; warning: number; info: number }
}

const SEV = {
  critical: { dot: 'bg-red-400',    text: 'text-red-400',    bg: 'bg-red-500/15',    border: 'border-red-500/30',    label: 'Critical' },
  warning:  { dot: 'bg-amber-400',  text: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/30',  label: 'Warning'  },
  info:     { dot: 'bg-blue-400',   text: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/30',   label: 'Info'     },
}

const CAT_LABELS: Record<string, string> = {
  auth:        'Auth',
  network:     'Network',
  certs:       'Certs',
  containers:  'Containers',
  system:      'System',
  game_server: 'Game Server',
}

function ScoreGauge({ score }: { score: number }) {
  const r = 38, cx = 50, cy = 50
  const circ = 2 * Math.PI * r
  const filled = (score / 100) * circ
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'
  const label = score >= 80 ? 'Good' : score >= 60 ? 'Fair' : 'At Risk'
  const textColor = score >= 80 ? 'text-green-400' : score >= 60 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#27272a" strokeWidth="8" />
        <circle
          cx={cx} cy={cy} r={r} fill="none"
          stroke={color} strokeWidth="8"
          strokeDasharray={`${filled} ${circ}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text x={cx} y={cy - 3} textAnchor="middle" fontSize="24" fontWeight="700" fill="white">{score}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fill="#71717a">/ 100</text>
      </svg>
      <div className={`text-xs font-semibold ${textColor}`}>{label}</div>
    </div>
  )
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000)    return 'just now'
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

export default function SecurityWidget() {
  const [data, setData] = useState<SecurityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [noData, setNoData] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all')
  const [scanning, setScanning] = useState(false)

  const load = () =>
    fetch('/api/security')
      .then((r) => {
        if (r.status === 404) { setNoData(true); return null }
        return r.json()
      })
      .then((d) => { if (d && !d.error) { setData(d); setNoData(false) } })
      .catch(() => {})

  async function triggerScan() {
    setScanning(true)
    try {
      await fetch('/api/security/scan', { method: 'POST' })
      await load()
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    load().finally(() => setLoading(false))
    const id = setInterval(load, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <div className="w-5 h-5 border-2 border-zinc-600 border-t-amber-400 rounded-full animate-spin" />
    </div>
  )

  if (noData || !data) return (
    <div className="text-center py-6 space-y-3">
      <div className="text-zinc-500 text-sm">No scan data yet</div>
      <button
        onClick={triggerScan}
        disabled={scanning}
        className="px-4 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md transition-colors"
      >
        {scanning ? 'Scanning…' : 'Run First Scan'}
      </button>
    </div>
  )

  const filtered = filter === 'all' ? data.findings : data.findings.filter((f) => f.severity === filter)

  // Category breakdown counts
  const byCat: Record<string, { critical: number; warning: number; info: number }> = {}
  for (const f of data.findings) {
    if (!byCat[f.category]) byCat[f.category] = { critical: 0, warning: 0, info: 0 }
    byCat[f.category][f.severity]++
  }

  return (
    <div className="space-y-4">
      {/* Score + severity counts */}
      <div className="flex items-center gap-4">
        <ScoreGauge score={data.score} />
        <div className="flex-1" />

        <div className="flex-1 space-y-1.5">
          {(['critical', 'warning', 'info'] as const).map((sev) => {
            const s = SEV[sev]
            const count = data.counts[sev]
            const active = filter === sev
            return (
              <button
                key={sev}
                onClick={() => setFilter(active ? 'all' : sev)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                  active ? `${s.bg} ${s.border}` : 'border-transparent hover:bg-zinc-800/40'
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot} ${!count ? 'opacity-30' : ''}`} />
                <span className={`font-semibold ${count ? s.text : 'text-zinc-600'}`}>{count}</span>
                <span className={count ? 'text-zinc-400' : 'text-zinc-700'}>{s.label}</span>
                {active && <span className="ml-auto text-zinc-600 text-[9px]">✕ clear</span>}
              </button>
            )
          })}
          <div className="flex items-center gap-2 pl-1 pt-0.5">
            <span className="text-[10px] text-zinc-700">Scanned {timeAgo(data.scanned_at)}</span>
            <button
              onClick={triggerScan}
              disabled={scanning}
              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 disabled:opacity-50 transition-colors"
            >
              {scanning ? '⟳ scanning…' : '⟳ rescan'}
            </button>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { val: data.stats.ssh_failures_24h.toLocaleString(), label: 'SSH fails/24h',
            color: data.stats.ssh_failures_24h > 200 ? 'text-red-400' : data.stats.ssh_failures_24h > 50 ? 'text-amber-400' : 'text-zinc-200' },
          { val: `${data.stats.disk_percent}%`, label: 'Disk used',
            color: data.stats.disk_percent >= 85 ? 'text-amber-400' : 'text-zinc-200' },
          { val: data.stats.game_open_ports.length, label: 'Game ports open',
            color: 'text-zinc-200' },
        ].map(({ val, label, color }) => (
          <div key={label} className="bg-zinc-800/40 rounded-lg p-2 text-center">
            <div className={`text-sm font-semibold ${color}`}>{val}</div>
            <div className="text-[10px] text-zinc-600 leading-tight mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Game server open ports */}
      {data.stats.game_open_ports.length > 0 && (
        <div className="bg-zinc-800/30 rounded-lg px-3 py-2">
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">
            {data.stats.game_server_ip} — Open Ports
          </div>
          <div className="flex flex-wrap gap-1">
            {data.stats.game_open_ports.map((p) => {
              const svcName = data.stats.game_services[p]
              const isRisky = [22, 8080, 8880, 2022].includes(p)
              return (
                <span
                  key={p}
                  className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                    isRisky ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-700/50 text-zinc-400'
                  }`}
                >
                  {p}{svcName ? ` ${svcName}` : ''}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Category breakdown */}
      {Object.keys(byCat).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(byCat).map(([cat, counts]) => {
            const total = counts.critical + counts.warning + counts.info
            const dotColor = counts.critical > 0 ? 'bg-red-400' : counts.warning > 0 ? 'bg-amber-400' : 'bg-blue-400'
            return (
              <span key={cat} className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-zinc-800/60 text-zinc-400">
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                {CAT_LABELS[cat] ?? cat}
                <span className="text-zinc-300 font-medium">{total}</span>
              </span>
            )
          })}
        </div>
      )}

      {/* Findings list */}
      {filtered.length > 0 ? (
        <div className="space-y-0.5">
          <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">
            {filter === 'all' ? 'All Findings' : `${SEV[filter].label} Findings`}
          </div>
          {filtered.map((f) => {
            const s = SEV[f.severity]
            const isExpanded = expanded === f.id
            return (
              <div key={f.id} className="rounded-lg overflow-hidden">
                <button
                  className={`w-full flex items-start gap-2 px-2.5 py-2 text-left transition-colors ${
                    isExpanded ? 'bg-zinc-800/80' : 'bg-zinc-800/30 hover:bg-zinc-800/60'
                  }`}
                  onClick={() => setExpanded(isExpanded ? null : f.id)}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${s.dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-200 leading-tight">{f.title}</div>
                    <div className="text-[10px] text-zinc-500 truncate mt-0.5">{f.detail}</div>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium ${s.bg} ${s.text} mt-0.5`}>
                    {CAT_LABELS[f.category] ?? f.category}
                  </span>
                  <span className="text-zinc-700 text-[10px] flex-shrink-0 mt-1">{isExpanded ? '▲' : '▼'}</span>
                </button>
                {isExpanded && (
                  <div className="bg-zinc-800/50 px-4 py-2.5 border-t border-zinc-700/40 space-y-1">
                    <div className="text-[10px] text-zinc-400">{f.detail}</div>
                    {f.recommendation && (
                      <div className="text-[10px] text-indigo-300">
                        <span className="text-zinc-600">↪ </span>{f.recommendation}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : data.findings.length === 0 ? (
        <div className="text-center py-4 space-y-1">
          <div className="text-green-400 text-sm font-medium">✓ No findings</div>
          <div className="text-zinc-600 text-xs">Everything looks clean</div>
        </div>
      ) : (
        <div className="text-center py-4 text-zinc-500 text-xs">No {filter} findings</div>
      )}
    </div>
  )
}
