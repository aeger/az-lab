'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import LabSubNav from '@/components/lab/LabSubNav'

function LogViewer() {
  const params = useSearchParams()
  const name = params.get('name') ?? ''
  const [logs, setLogs] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tail, setTail] = useState('200')

  const fetchLogs = useCallback(() => {
    if (!name) return
    setLoading(true)
    setError(null)
    fetch(`/api/containers/logs?name=${encodeURIComponent(name)}&tail=${tail}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error)
        else setLogs(d.logs ?? '')
      })
      .catch(() => setError('Request failed'))
      .finally(() => setLoading(false))
  }, [name, tail])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-sm font-semibold text-zinc-300">
          Logs: <span className="text-white font-mono">{name || '—'}</span>
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={tail}
            onChange={(e) => setTail(e.target.value)}
            className="text-[10px] px-2 py-1 rounded bg-zinc-900 border border-zinc-700/50 text-zinc-300 focus:outline-none"
          >
            {['50','100','200','500','1000'].map((n) => (
              <option key={n} value={n}>Last {n} lines</option>
            ))}
          </select>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="text-xs px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/50 disabled:opacity-50 transition-colors"
          >
            {loading ? '⟳' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-xs text-red-400">{error}</div>
      )}

      {loading && !logs ? (
        <div className="flex items-center justify-center h-32">
          <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      ) : (
        <pre className="bg-zinc-950 border border-zinc-800/60 rounded-xl p-4 text-[11px] font-mono text-zinc-300 overflow-auto max-h-[70vh] whitespace-pre-wrap leading-relaxed">
          {logs || <span className="text-zinc-600">No log output</span>}
        </pre>
      )}
    </div>
  )
}

export default function ContainerLogsPage() {
  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <LabSubNav />
      <Suspense fallback={<div className="text-zinc-500 text-sm">Loading…</div>}>
        <LogViewer />
      </Suspense>
    </div>
  )
}
