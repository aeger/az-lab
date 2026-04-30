'use client'

import { useEffect, useState } from 'react'
import type { HostMetrics as HostMetricsType } from '@/lib/prometheus'

function tileColor(value: number | null, type: 'pct' | 'uptime' | 'load'): string {
  if (value == null) return 'rgba(39,39,42,0.8)' // zinc-800
  if (type === 'uptime') return 'rgba(37,99,235,0.75)' // blue
  if (type === 'load') {
    return value >= 4 ? 'rgba(220,38,38,0.75)' : value >= 2 ? 'rgba(217,119,6,0.75)' : 'rgba(22,163,74,0.75)'
  }
  // pct — green < 70, amber 70-85, red > 85
  if (value >= 85) return 'rgba(220,38,38,0.75)'
  if (value >= 70) return 'rgba(217,119,6,0.75)'
  return 'rgba(22,163,74,0.75)'
}

function StatTile({
  label,
  value,
  unit,
  sub,
  color,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  color: string
}) {
  return (
    <div
      className="flex flex-col justify-between rounded-xl p-3 min-w-0"
      style={{ background: color, minHeight: '88px' }}
    >
      <div className="text-[10px] font-semibold text-white/70 uppercase tracking-wider">{label}</div>
      <div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold text-white leading-none">{value}</span>
          {unit && <span className="text-sm font-medium text-white/80">{unit}</span>}
        </div>
        {sub && <div className="text-[10px] text-white/60 mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

export default function HostMetrics() {
  const [metrics, setMetrics] = useState<HostMetricsType[]>([])
  const [loading, setLoading] = useState(true)

  const load = () =>
    fetch('/api/metrics')
      .then((r) => r.json())
      .then((d) => setMetrics(d.metrics ?? []))
      .catch(() => {})

  useEffect(() => {
    load().finally(() => setLoading(false))
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
    </div>
  )

  if (metrics.length === 0) return (
    <div className="text-zinc-500 text-sm text-center py-6">Prometheus not configured</div>
  )

  return (
    <div className="space-y-4">
      {metrics.map((host) => {
        const uptimeDays = host.uptime_days != null
          ? `${host.uptime_days.toFixed(2)} days`
          : '—'
        const ramUsed = host.ram_used_gb != null ? `${host.ram_used_gb} GiB` : '—'
        const ramPct = host.ram_used_percent != null ? host.ram_used_percent.toFixed(1) : '—'
        const cpuPct = host.cpu_percent != null ? host.cpu_percent.toFixed(2) : '—'
        const diskPct = host.disk_used_percent != null ? host.disk_used_percent.toFixed(1) : '—'
        const load1m = host.load_1m != null ? host.load_1m.toFixed(2) : '—'

        return (
          <div key={host.instance}>
            {metrics.length > 1 && (
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-xs font-semibold text-zinc-400">{host.name}</span>
              </div>
            )}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              <StatTile
                label="CPU Usage"
                value={cpuPct}
                unit="%"
                color={tileColor(host.cpu_percent, 'pct')}
              />
              <StatTile
                label="RAM Usage"
                value={ramPct}
                unit="%"
                color={tileColor(host.ram_used_percent, 'pct')}
              />
              <StatTile
                label="RAM Used"
                value={ramUsed}
                color={tileColor(host.ram_used_percent, 'pct')}
              />
              <StatTile
                label="Load Avg (1m)"
                value={load1m}
                color={tileColor(host.load_1m, 'load')}
              />
              <StatTile
                label="Uptime"
                value={uptimeDays}
                color={tileColor(1, 'uptime')}
              />
              <StatTile
                label="Root Disk Usage"
                value={diskPct}
                unit="%"
                color={tileColor(host.disk_used_percent, 'pct')}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
