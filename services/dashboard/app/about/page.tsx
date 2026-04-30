'use client'

import { useState, useEffect } from 'react'
import AuthIndicator from '@/components/shared/AuthIndicator'

interface ServiceStatus {
  name: string
  version: string
  status: 'running' | 'down'
  description: string
}

export default function AboutPage() {
  const [services, setServices] = useState<ServiceStatus[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        // Fetch Sentinel status
        const sentinelRes = await fetch('https://sentinel-api.az-lab.dev/api/health')
        const sentinelStatus: ServiceStatus = sentinelRes.ok
          ? {
              name: 'JeffSentinel',
              version: '2.0.0',
              status: 'running',
              description: 'Unified homelab notification aggregator with Fusion Mode',
            }
          : {
              name: 'JeffSentinel',
              version: '2.0.0',
              status: 'down',
              description: 'Unified homelab notification aggregator with Fusion Mode',
            }

        setServices([sentinelStatus])
      } catch (err) {
        console.error('Failed to fetch service status:', err)
        setServices([
          {
            name: 'JeffSentinel',
            version: '2.0.0',
            status: 'down',
            description: 'Unified homelab notification aggregator with Fusion Mode',
          },
        ])
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
  }, [])

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-zinc-100 mb-2">About</h1>
          <p className="text-sm text-zinc-500">AZ-Lab Home Server Dashboard</p>
        </div>
        <AuthIndicator />
      </div>

      {/* Dashboard Info */}
      <div
        className="rounded-xl border border-zinc-800/70 p-6 mb-8"
        style={{ background: 'rgba(9, 9, 11, 0.5)' }}
      >
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest mb-4">
          Dashboard
        </h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Version</span>
            <span className="text-zinc-100 font-mono">0.1.0</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Framework</span>
            <span className="text-zinc-100">Next.js 16 + React 19</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Built</span>
            <span className="text-zinc-100 font-mono">2026-04-15</span>
          </div>
        </div>
      </div>

      {/* Services Status */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest mb-4">
          Services
        </h2>

        {loading ? (
          <div className="text-center text-zinc-600 py-8">Loading service status...</div>
        ) : (
          <div className="grid gap-4">
            {services.map((service) => (
              <div
                key={service.name}
                className="rounded-xl border border-zinc-800/70 p-6"
                style={{ background: 'rgba(9, 9, 11, 0.5)' }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">{service.name}</h3>
                    <p className="text-xs text-zinc-600 mt-1">{service.description}</p>
                  </div>
                  <div
                    className="px-2 py-1 rounded text-xs font-mono"
                    style={{
                      background:
                        service.status === 'running'
                          ? 'rgba(34, 197, 94, 0.15)'
                          : 'rgba(239, 68, 68, 0.15)',
                      color: service.status === 'running' ? '#22c55e' : '#ef4444',
                      border:
                        service.status === 'running'
                          ? '1px solid rgba(34, 197, 94, 0.3)'
                          : '1px solid rgba(239, 68, 68, 0.3)',
                    }}
                  >
                    {service.status === 'running' ? '✓ Running' : '✗ Down'}
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-zinc-600">
                  <span>v{service.version}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Features */}
      <div className="mt-8 rounded-xl border border-zinc-800/70 p-6" style={{ background: 'rgba(9, 9, 11, 0.5)' }}>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest mb-4">
          JeffSentinel v2 Features
        </h2>
        <ul className="space-y-2 text-sm text-zinc-400">
          <li className="flex items-start gap-3">
            <span className="text-green-500 mt-0.5">✓</span>
            <span>Unified notification aggregation from multiple sources</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-green-500 mt-0.5">✓</span>
            <span>Fusion Mode with extension connection verification</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-green-500 mt-0.5">✓</span>
            <span>Full action parity: Mark Read, Hand Back, Restart, Snooze</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-green-500 mt-0.5">✓</span>
            <span>Cross-device mirroring for synchronized notifications</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-green-500 mt-0.5">✓</span>
            <span>Settings export/import for backup and restore</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-green-500 mt-0.5">✓</span>
            <span>Auto-migration from v1.2.0 with migration summary</span>
          </li>
        </ul>
      </div>
    </main>
  )
}
