'use client'

import { useEffect, useState } from 'react'
import StatusBadge from '@/components/shared/StatusBadge'
import type { Monitor } from '@/lib/uptime-kuma'

export default function ServiceGrid() {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/services')
      const data = await res.json()
      setMonitors(data.monitors ?? [])
      setLastRefresh(new Date())
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
    </div>
  )

  if (monitors.length === 0) return (
    <div className="text-zinc-500 text-sm text-center py-6">
      Uptime Kuma not configured or status page empty
    </div>
  )

  const upCount = monitors.filter((m) => m.status === 'up').length

  return (
    <div>
      <div className="flex items-center justify-between mb-2 text-xs text-zinc-500">
        <span>{upCount}/{monitors.length} up</span>
        <span>Updated {lastRefresh?.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div className="space-y-1.5">
        {monitors.map((m) => (
          <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/70 transition-colors">
            <span className="text-sm text-zinc-200 truncate">{m.name}</span>
            <div className="flex items-center gap-2 flex-shrink-0">
              {m.ping != null && <span className="text-xs text-zinc-500">{m.ping}ms</span>}
              <StatusBadge status={m.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
