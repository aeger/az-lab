'use client'

import { useEffect, useState } from 'react'
import type { TraefikRouter } from '@/app/api/traefik/route'

function fmt(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toFixed(0)
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: color + '22', color }}>
      {label}
    </span>
  )
}

export default function TraefikRouters() {
  const [routers, setRouters] = useState<TraefikRouter[]>([])
  const [loading, setLoading] = useState(true)

  const load = () =>
    fetch('/api/traefik')
      .then(r => r.json())
      .then(d => setRouters(d.routers ?? []))
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

  if (routers.length === 0) return (
    <div className="text-zinc-500 text-sm text-center py-6">No Traefik metrics available</div>
  )

  return (
    <div>
      {/* Header */}
      <div className="grid text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-2 px-2"
        style={{ gridTemplateColumns: '1fr 160px 70px 60px 60px 60px 60px' }}>
        <span>Router</span>
        <span>Hostname</span>
        <span className="text-right">Req/min</span>
        <span className="text-right">Total</span>
        <span className="text-right">4xx</span>
        <span className="text-right">5xx</span>
        <span className="text-right">↻</span>
      </div>

      <div className="space-y-0.5">
        {routers.map(r => {
          const hasErrors = r.errors_5xx > 0
          const hasWarnings = r.errors_4xx > 50
          const accentColor = hasErrors ? '#ef4444' : hasWarnings ? '#f59e0b' : '#34d399'

          return (
            <div
              key={r.name}
              className="grid items-center px-2 py-2 rounded-lg hover:bg-zinc-800/40 transition-colors gap-x-2"
              style={{ gridTemplateColumns: '1fr 160px 70px 60px 60px 60px 60px' }}
            >
              {/* Name + badges */}
              <div className="min-w-0 flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accentColor }} />
                <span className="text-xs font-medium text-zinc-200 truncate">{r.name}</span>
                {r.auth && <Badge label="auth" color="#a78bfa" />}
                {r.lanOnly && <Badge label="lan" color="#22d3ee" />}
                <Badge label={r.provider} color="#71717a" />
              </div>

              {/* Hostname */}
              <span className="text-xs text-zinc-500 truncate font-mono">{r.hostname || '—'}</span>

              {/* Rate */}
              <span className="text-right text-xs font-mono text-cyan-400">
                {r.req_per_min > 0 ? r.req_per_min.toFixed(1) : '—'}
              </span>

              {/* Total */}
              <span className="text-right text-xs font-mono text-zinc-400">{fmt(r.total_requests)}</span>

              {/* 4xx */}
              <span className="text-right text-xs font-mono" style={{ color: r.errors_4xx > 50 ? '#f59e0b' : '#52525b' }}>
                {r.errors_4xx > 0 ? fmt(r.errors_4xx) : '—'}
              </span>

              {/* 5xx */}
              <span className="text-right text-xs font-mono" style={{ color: r.errors_5xx > 0 ? '#ef4444' : '#52525b' }}>
                {r.errors_5xx > 0 ? fmt(r.errors_5xx) : '—'}
              </span>

              {/* Redirects */}
              <span className="text-right text-xs font-mono text-zinc-600">
                {r.redirects > 0 ? fmt(r.redirects) : '—'}
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-3 text-[10px] text-zinc-700 text-right">
        Req/min = 5m rate · All-time totals since last Prometheus restart
      </div>
    </div>
  )
}
