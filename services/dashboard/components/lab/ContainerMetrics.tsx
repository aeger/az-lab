'use client'

import { useEffect, useState } from 'react'
import type { ContainerMetric } from '@/app/api/containers/metrics/route'

function fmt(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  if (bytes >= 1048576)    return `${(bytes / 1048576).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function fmtRate(bps: number | null): string {
  if (bps == null || bps < 0.1) return '—'
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`
  if (bps >= 1024)    return `${(bps / 1024).toFixed(0)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function Bar({ pct, color }: { pct: number | null; color: string }) {
  const v = Math.min(pct ?? 0, 100)
  return (
    <div className="w-full h-1 rounded-full bg-zinc-800 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${v}%`, background: color }} />
    </div>
  )
}

function cpuColor(v: number | null) {
  if (v == null) return '#52525b'
  if (v >= 80) return '#ef4444'
  if (v >= 40) return '#f59e0b'
  return '#22d3ee'
}

function memColor(v: number | null) {
  if (v == null) return '#52525b'
  if (v >= 85) return '#ef4444'
  if (v >= 70) return '#f59e0b'
  return '#34d399'
}

export default function ContainerMetrics() {
  const [containers, setContainers] = useState<ContainerMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const load = () =>
    fetch('/api/containers/metrics')
      .then(r => r.json())
      .then(d => setContainers(d.containers ?? []))
      .catch(() => {})

  useEffect(() => {
    load().finally(() => setLoading(false))
    const id = setInterval(load, 20000)
    return () => clearInterval(id)
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
    </div>
  )

  if (containers.length === 0) return (
    <div className="text-zinc-500 text-sm text-center py-6">Prometheus / Podman exporter not available</div>
  )

  const running = containers.filter(c => c.state === 4)
  const stopped = containers.filter(c => c.state !== 4)
  const visible = showAll ? containers : running

  return (
    <div>
      {/* Summary row */}
      <div className="flex items-center gap-4 mb-3 text-xs text-zinc-500">
        <span><span className="text-green-400 font-semibold">{running.length}</span> running</span>
        {stopped.length > 0 && <span><span className="text-zinc-500 font-semibold">{stopped.length}</span> stopped</span>}
        <button
          onClick={() => setShowAll(v => !v)}
          className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {showAll ? 'Hide stopped' : 'Show all'}
        </button>
      </div>

      {/* Header */}
      <div className="grid text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-1 px-2"
        style={{ gridTemplateColumns: '1fr 60px 80px 80px 70px 70px' }}>
        <span>Container</span>
        <span className="text-right">CPU%</span>
        <span className="text-right">Memory</span>
        <span className="text-right">Mem%</span>
        <span className="text-right">RX</span>
        <span className="text-right">TX</span>
      </div>

      <div className="space-y-1">
        {visible.map(c => {
          const isRunning = c.state === 4
          return (
            <div
              key={c.id}
              className="grid items-center px-2 py-1.5 rounded-lg hover:bg-zinc-800/40 transition-colors gap-x-2"
              style={{ gridTemplateColumns: '1fr 60px 80px 80px 70px 70px', opacity: isRunning ? 1 : 0.45 }}
            >
              {/* Name + bars */}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: isRunning ? '#4ade80' : '#52525b' }} />
                  <span className="text-xs font-medium text-zinc-200 truncate">{c.name}</span>
                </div>
                <div className="flex gap-1">
                  <div className="flex-1"><Bar pct={c.cpu_pct} color={cpuColor(c.cpu_pct)} /></div>
                  <div className="flex-1"><Bar pct={c.mem_pct} color={memColor(c.mem_pct)} /></div>
                </div>
              </div>

              <span className="text-right text-xs font-mono" style={{ color: cpuColor(c.cpu_pct) }}>
                {c.cpu_pct != null ? `${c.cpu_pct.toFixed(1)}%` : '—'}
              </span>
              <span className="text-right text-xs font-mono text-zinc-300">{fmt(c.mem_bytes)}</span>
              <span className="text-right text-xs font-mono" style={{ color: memColor(c.mem_pct) }}>
                {c.mem_pct != null ? `${c.mem_pct.toFixed(1)}%` : '—'}
              </span>
              <span className="text-right text-xs font-mono text-zinc-500">{fmtRate(c.net_rx)}</span>
              <span className="text-right text-xs font-mono text-zinc-500">{fmtRate(c.net_tx)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
