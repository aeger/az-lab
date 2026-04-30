'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import StatusBadge from '@/components/shared/StatusBadge'
import type { Container } from '@/lib/portainer'

interface UpdateInfo {
  name: string
  has_update: boolean
  status: string
  user_status: string
  risk?: string
  current_version?: string
  latest_version?: string
  changelog_summary?: string
  changelog_url?: string
  scheduled_time?: string
  skipped_at?: string
  skip_reassess_at?: string
  completed_at?: string
  last_result?: { success: boolean; error?: string }
}

interface UpdateState {
  checked_at: string | null
  enriched_at?: string | null
  updates_available?: number
  containers: UpdateInfo[]
  policy?: { auto_risk_threshold?: string }
}

interface ContainerMetrics {
  name: string
  cpu_percent: number
  mem_mb: number
  mem_limit_mb: number
}

const RISK_COLORS: Record<string, string> = {
  patch:   'bg-green-500/20 text-green-400',
  rebuild: 'bg-green-500/20 text-green-400',
  minor:   'bg-amber-500/20 text-amber-400',
  major:   'bg-red-500/20 text-red-400',
  unknown: 'bg-amber-500/20 text-amber-400',
}

const RISK_LABELS: Record<string, string> = {
  patch:   'PATCH',
  rebuild: 'REBUILD',
  minor:   'MINOR',
  major:   'MAJOR',
  unknown: 'UPDATE',
}

const STACKS: Record<string, { label: string; containers: string[] }> = {
  immich:     { label: 'Immich',      containers: ['immich-server', 'immich-machine-learning', 'immich-redis', 'immich-postgres'] },
  monitoring: { label: 'Monitoring',  containers: ['prometheus', 'grafana', 'node_exporter', 'cadvisor', 'blackbox', 'snmp_exporter', 'podman_exporter'] },
  rustdesk:   { label: 'RustDesk',    containers: ['hbbs', 'hbbr'] },
  dashboard:  { label: 'Dashboard',   containers: ['az-dashboard', 'uptime-kuma'] },
}

function extractUptime(statusStr: string): string {
  const m = statusStr.match(/^Up (.+)$/)
  return m ? m[1] : ''
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-16 h-1 bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

function HealthBar({ running, total }: { running: number; total: number }) {
  const pct = total > 0 ? (running / total) * 100 : 0
  const color = pct === 100 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-zinc-500 tabular-nums">{running}/{total}</span>
    </div>
  )
}

function RiskBadge({ update }: { update: UpdateInfo }) {
  const status = update.user_status
  const risk = update.risk || 'unknown'
  if (status === 'skipped') {
    const daysLeft = update.skip_reassess_at
      ? Math.max(0, Math.ceil((new Date(update.skip_reassess_at).getTime() - Date.now()) / 86400000))
      : 0
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-500 font-medium">SKIPPED{daysLeft > 0 ? ` ${daysLeft}d` : ''}</span>
  }
  if (status === 'auto_approved') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">AUTO 3AM</span>
  if (status === 'requested' || status === 'in_progress') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium animate-pulse">UPDATING</span>
  if (status === 'scheduled') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-600/50 text-zinc-300 font-medium">SCHEDULED</span>
  if (status === 'ignored') return null
  if (status === 'completed') {
    const age = update.completed_at ? Date.now() - new Date(update.completed_at).getTime() : Infinity
    if (age > 86400000) return null
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">UPDATED</span>
  }
  if (status === 'failed') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">FAILED</span>
  const colorClass = RISK_COLORS[risk] || RISK_COLORS.unknown
  const label = RISK_LABELS[risk] || 'UPDATE'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colorClass}`}>{label}</span>
}

function ActionBtn({ label, icon, onClick, disabled, color }: {
  label: string; icon: string; onClick: (e: React.MouseEvent) => void; disabled: boolean; color?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors disabled:opacity-30 ${color ?? 'text-zinc-400 bg-zinc-800/60 hover:bg-zinc-700'}`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function ContainerRow({ c, update, metrics, acting, rebuilding, forceRestarting, actionLoading, updateResult, onAction, onUpdateAction }: {
  c: Container
  update?: UpdateInfo
  metrics?: ContainerMetrics
  acting: { id: string; action: string } | null
  rebuilding: string | null
  forceRestarting: string | null
  actionLoading: string | null
  updateResult: { name: string; ok: boolean; msg: string } | null
  onAction: (c: Container, action: string) => void
  onUpdateAction: (name: string, action: string) => void
}) {
  const [showDetail, setShowDetail] = useState(false)
  const isRunning = c.state === 'running'
  const isBusy = acting?.id === c.id
  const isRebuilding = rebuilding === c.name
  const isForceRestarting = forceRestarting === c.name
  const hasUpdate = (update?.has_update ?? false) && update?.user_status !== 'ignored'
  const uptime = extractUptime(c.status)

  const cpuPct = metrics?.cpu_percent ?? 0
  const memPct = metrics && metrics.mem_limit_mb > 0 ? (metrics.mem_mb / metrics.mem_limit_mb) * 100 : 0
  const cpuColor = cpuPct > 80 ? 'bg-red-500' : cpuPct > 50 ? 'bg-amber-500' : 'bg-sky-500'
  const memColor = memPct > 80 ? 'bg-red-500' : memPct > 50 ? 'bg-amber-500' : 'bg-purple-500'

  return (
    <div className="rounded-lg border border-zinc-800/60 overflow-hidden">
      <div
        className={`grid items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${showDetail ? 'bg-zinc-800/60' : 'bg-zinc-900/40 hover:bg-zinc-800/50'}`}
        style={{ gridTemplateColumns: '1fr auto auto auto auto' }}
        onClick={() => setShowDetail(!showDetail)}
      >
        {/* Name + image */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-200">{c.name}</span>
            {hasUpdate && update && <RiskBadge update={update} />}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
            <span>{c.image.split(':')[0].split('/').pop()}</span>
            {(() => {
              const tag = c.image.split(':')[1]
              const skip = ['latest', 'stable', 'release', 'main', 'master', 'edge', 'lts', 'current', undefined]
              return tag && !skip.includes(tag) ? <span className="text-zinc-700">{tag}</span> : null
            })()}
            {update?.current_version && hasUpdate && update.latest_version && (
              <span className="text-zinc-600">{update.current_version} → <span className="text-zinc-400">{update.latest_version}</span></span>
            )}
          </div>
        </div>

        {/* CPU / mem mini bars */}
        {isRunning && metrics ? (
          <div className="flex flex-col gap-1 min-w-[80px]" title={`CPU: ${cpuPct.toFixed(1)}%  Mem: ${metrics.mem_mb.toFixed(0)}MB`}>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-zinc-700 w-6">CPU</span>
              <MiniBar pct={cpuPct} color={cpuColor} />
              <span className="text-[9px] text-zinc-600 tabular-nums w-8 text-right">{cpuPct.toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-zinc-700 w-6">MEM</span>
              <MiniBar pct={memPct} color={memColor} />
              <span className="text-[9px] text-zinc-600 tabular-nums w-8 text-right">{metrics.mem_mb.toFixed(0)}M</span>
            </div>
          </div>
        ) : <div className="min-w-[80px]" />}

        {/* Uptime */}
        <div className="text-xs text-zinc-600 tabular-nums text-right min-w-[80px]">
          {uptime || <span className="text-zinc-700">—</span>}
        </div>

        {/* Status + actions */}
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <StatusBadge status={c.state} />
          {isRunning ? (
            <>
              <ActionBtn label="Restart" icon="↻" onClick={(e) => { e.stopPropagation(); onAction(c, 'restart') }} disabled={isBusy || isRebuilding} />
              <ActionBtn label="Stop" icon="■" onClick={(e) => { e.stopPropagation(); onAction(c, 'stop') }} disabled={isBusy || isRebuilding} color="text-red-400 bg-red-950/30 hover:bg-red-900/40" />
            </>
          ) : (
            <ActionBtn label="Start" icon="▶" onClick={(e) => { e.stopPropagation(); onAction(c, 'start') }} disabled={isBusy || isRebuilding} color="text-green-400 bg-green-950/30 hover:bg-green-900/40" />
          )}
          <ActionBtn
            label={isRebuilding ? 'Pulling…' : 'Pull'}
            icon="⇓"
            onClick={(e) => { e.stopPropagation(); onAction(c, 'rebuild') }}
            disabled={isBusy || isRebuilding || isForceRestarting}
            color="text-sky-400 bg-sky-950/30 hover:bg-sky-900/40"
          />
          <ActionBtn
            label={isForceRestarting ? 'Restarting…' : 'Force ↻'}
            icon="⚡"
            onClick={(e) => { e.stopPropagation(); onAction(c, 'force-restart') }}
            disabled={isBusy || isRebuilding || isForceRestarting}
            color="text-orange-400 bg-orange-950/30 hover:bg-orange-900/40"
          />
          {(isBusy || isRebuilding || isForceRestarting) && <div className="w-3.5 h-3.5 border border-zinc-500 border-t-zinc-200 rounded-full animate-spin" />}
        </div>

        {/* Chevron */}
        <div className="text-zinc-700 text-xs select-none">{showDetail ? '▲' : '▼'}</div>
      </div>

      {/* Detail panel */}
      {showDetail && (
        <div className="px-4 py-3 bg-zinc-800/40 border-t border-zinc-800/60 space-y-3">
          <div className="flex items-center gap-2 mb-1" onClick={(e) => e.stopPropagation()}>
            <a
              href={`/lab/containers/logs?name=${encodeURIComponent(c.name)}`}
              className="text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700/50 transition-colors"
            >
              📋 Logs
            </a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Image</div>
              <div className="text-xs text-zinc-400 font-mono break-all">{c.image.split(':')[0].split('/').pop()}</div>
            </div>
            {(() => {
              const tag = c.image.split(':')[1]
              return tag ? (
                <div>
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Tag</div>
                  <div className="text-xs text-zinc-400 font-mono">{tag}</div>
                </div>
              ) : null
            })()}
            {uptime && (
              <div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Uptime</div>
                <div className="text-xs text-zinc-300">{uptime}</div>
              </div>
            )}
            {metrics && isRunning && (
              <div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Resources</div>
                <div className="text-xs text-zinc-400">CPU {cpuPct.toFixed(1)}% · {metrics.mem_mb.toFixed(0)} MB{metrics.mem_limit_mb > 0 ? ` / ${metrics.mem_limit_mb.toFixed(0)} MB` : ''}</div>
              </div>
            )}
          </div>

          {update ? (
            update.has_update ? (
              <div className="border-t border-zinc-700/50 pt-3 space-y-2">
                {(update.current_version || update.latest_version) && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-[10px] text-zinc-600 uppercase tracking-wider w-16">Version</span>
                    <span className="text-zinc-400 font-mono">{update.current_version ?? '?'}</span>
                    <span className="text-zinc-600">→</span>
                    <span className="text-zinc-200 font-mono">{update.latest_version ?? '?'}</span>
                    {update.risk && (
                      <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        update.risk === 'major' ? 'bg-red-500/20 text-red-400' :
                        update.risk === 'minor' ? 'bg-amber-500/20 text-amber-400' :
                        'bg-green-500/20 text-green-400'
                      }`}>{update.risk}</span>
                    )}
                  </div>
                )}
                {update.changelog_summary && (
                  <div>
                    <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Changelog</div>
                    <p className="text-xs text-zinc-400 leading-relaxed">{update.changelog_summary}</p>
                  </div>
                )}
                {update.changelog_url && (
                  <a href={update.changelog_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                    Full release notes ↗
                  </a>
                )}
                {update.user_status === 'completed' && update.completed_at && (
                  <p className="text-xs text-green-400">Updated {formatTimeAgo(update.completed_at)}</p>
                )}
                {update.user_status === 'failed' && update.last_result?.error && (
                  <p className="text-xs text-red-400">Error: {update.last_result.error}</p>
                )}
                {update.user_status === 'requested' && (
                  <p className="text-xs text-blue-400 animate-pulse">Update queued — processing shortly</p>
                )}
                {update.user_status === 'scheduled' && update.scheduled_time && (
                  <p className="text-xs text-zinc-400">Scheduled for {new Date(update.scheduled_time).toLocaleString()}</p>
                )}
                {update.user_status === 'skipped' && update.skip_reassess_at && (
                  <p className="text-xs text-zinc-500">Skipped — reassess {new Date(update.skip_reassess_at).toLocaleDateString()}</p>
                )}
                <div className="flex gap-2 pt-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
                  {['pending_review', 'failed', 'notified'].includes(update.user_status) && (<>
                    <button onClick={() => onUpdateAction(c.name, 'update_now')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors">Update Now</button>
                    <button onClick={() => onUpdateAction(c.name, 'schedule')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 disabled:opacity-50 transition-colors">Schedule 3 AM</button>
                    <button onClick={() => onUpdateAction(c.name, 'skip')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 disabled:opacity-50 transition-colors">Skip 30d</button>
                    <button onClick={() => onUpdateAction(c.name, 'ignore')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-600 hover:text-zinc-400 disabled:opacity-50 transition-colors">Ignore</button>
                  </>)}
                  {update.user_status === 'auto_approved' && (<>
                    <span className="text-xs text-blue-400 self-center">Auto-updating at 3:47 AM</span>
                    <button onClick={() => onUpdateAction(c.name, 'update_now')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 disabled:opacity-50 transition-colors">Update Now</button>
                    <button onClick={() => onUpdateAction(c.name, 'skip')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 disabled:opacity-50 transition-colors">Skip</button>
                  </>)}
                  {update.user_status === 'scheduled' && (<>
                    <button onClick={() => onUpdateAction(c.name, 'update_now')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 disabled:opacity-50 transition-colors">Update Now</button>
                    <button onClick={() => onUpdateAction(c.name, 'skip')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 disabled:opacity-50 transition-colors">Skip</button>
                  </>)}
                  {update.user_status === 'skipped' && (<>
                    <button onClick={() => onUpdateAction(c.name, 'update_now')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors">Update Now</button>
                    <button onClick={() => onUpdateAction(c.name, 'schedule')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 disabled:opacity-50 transition-colors">Schedule 3 AM</button>
                  </>)}
                  {update.user_status === 'ignored' && (
                    <button onClick={() => onUpdateAction(c.name, 'unignore')} disabled={actionLoading === c.name} className="text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 disabled:opacity-50 transition-colors">Unignore</button>
                  )}
                  {actionLoading === c.name && <div className="w-4 h-4 border border-zinc-500 border-t-zinc-200 rounded-full animate-spin self-center" />}
                  {updateResult?.name === c.name && (
                    <span className={`text-xs self-center ${updateResult.ok ? 'text-green-400' : 'text-red-400'}`}>{updateResult.msg}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="border-t border-zinc-700/50 pt-2">
                <span className="text-[10px] text-zinc-700 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500/60" />
                  Image up to date
                  {update.current_version && <span className="ml-1 font-mono">{update.current_version}</span>}
                </span>
              </div>
            )
          ) : (
            <div className="border-t border-zinc-700/50 pt-2">
              <span className="text-[10px] text-zinc-700">No update data</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ContainerListExpanded() {
  const [containers, setContainers] = useState<Container[]>([])
  const [updates, setUpdates] = useState<UpdateState>({ checked_at: null, containers: [] })
  const [metrics, setMetrics] = useState<ContainerMetrics[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<{ id: string; action: string } | null>(null)
  const [rebuilding, setRebuilding] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [stackUpdating, setStackUpdating] = useState<string | null>(null)
  const [stackError, setStackError] = useState<string | null>(null)
  const [updateResult, setUpdateResult] = useState<{ name: string; ok: boolean; msg: string } | null>(null)
  const [forceRestarting, setForceRestarting] = useState<string | null>(null)
  const [rollingRestart, setRollingRestart] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // collapsed state: undefined = auto, true = collapsed, false = expanded
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const initializedRef = useRef(false)

  const refresh = useCallback(() => {
    fetch('/api/containers').then((r) => r.json()).then((d) => setContainers(d.containers ?? [])).catch(() => {})
  }, [])

  const refreshUpdates = useCallback(() => {
    fetch('/api/containers/updates/state').then((r) => r.json()).then((d) => setUpdates(d)).catch(() => {})
  }, [])

  const refreshMetrics = useCallback(() => {
    fetch('/api/containers/metrics').then((r) => r.json()).then((d) => setMetrics(d.metrics ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    Promise.all([
      fetch('/api/containers').then((r) => r.json()).then((d) => setContainers(d.containers ?? [])),
      fetch('/api/containers/updates/state').then((r) => r.json()).then((d) => setUpdates(d)),
      fetch('/api/containers/metrics').then((r) => r.json()).then((d) => setMetrics(d.metrics ?? [])),
    ]).finally(() => setLoading(false))
    const i1 = setInterval(refresh, 60000)
    const i2 = setInterval(refreshUpdates, 30000)
    const i3 = setInterval(refreshMetrics, 15000)
    return () => { clearInterval(i1); clearInterval(i2); clearInterval(i3) }
  }, [refresh, refreshUpdates, refreshMetrics])

  const updateMap = new Map(updates.containers.map((u) => [u.name, u]))
  const metricsMap = new Map(metrics.map((m) => [m.name, m]))

  async function handleAction(c: Container, action: string) {
    if (action === 'rebuild') {
      setRebuilding(c.name)
      await fetch('/api/containers/rebuild', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ containerName: c.name }) }).catch(() => {})
      setTimeout(() => { refresh(); setRebuilding(null) }, 3000)
      return
    }
    if (action === 'force-restart') {
      setForceRestarting(c.name)
      await fetch('/api/containers/force-restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ containerName: c.name }) }).catch(() => {})
      setTimeout(() => { refresh(); setForceRestarting(null) }, 3000)
      return
    }
    setActing({ id: c.id, action })
    setContainers((prev) => prev.map((ct) => {
      if (ct.id !== c.id) return ct
      if (action === 'stop') return { ...ct, state: 'exited', status: 'Stopping...' }
      if (action === 'start') return { ...ct, state: 'running', status: 'Starting...' }
      if (action === 'restart') return { ...ct, state: 'restarting', status: 'Restarting...' }
      return ct
    }))
    await fetch('/api/containers/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpointId: c.endpointId, containerId: c.id, action }) }).catch(() => {})
    setTimeout(() => { refresh(); setActing(null) }, 2000)
  }

  async function handleUpdateAction(name: string, action: string) {
    setActionLoading(name)
    setUpdateResult(null)
    try {
      const res = await fetch('/api/containers/updates/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ container: name, action }) })
      const data = await res.json().catch(() => ({}))
      if (action === 'update_now') {
        if (res.ok && data.success) {
          setUpdateResult({ name, ok: true, msg: `✓ Updated successfully` })
        } else {
          setUpdateResult({ name, ok: false, msg: data.error || `Update failed (${res.status})` })
        }
        setTimeout(() => setUpdateResult(null), 10000)
      }
    } catch {
      if (action === 'update_now') {
        setUpdateResult({ name, ok: false, msg: 'Network error — update failed' })
        setTimeout(() => setUpdateResult(null), 10000)
      }
    }
    refreshUpdates()
    setActionLoading(null)
  }

  async function handleStackUpdate(stackName: string) {
    setStackUpdating(stackName)
    setStackError(null)
    try {
      const res = await fetch('/api/containers/stack-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stackName }) })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setStackError(data.error || `Stack update failed (${res.status})`)
      }
    } catch {
      setStackError('Network error — stack update failed')
    }
    setTimeout(() => { refresh(); setStackUpdating(null) }, 4000)
  }

  // Group action: restart/stop/start all containers in a stack
  async function handleGroupAction(groupContainers: Container[], action: string) {
    for (const c of groupContainers) {
      if (action === 'stop' && c.state !== 'running') continue
      if (action === 'start' && c.state === 'running') continue
      await fetch('/api/containers/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointId: c.endpointId, containerId: c.id, action }),
      }).catch(() => {})
    }
    setTimeout(refresh, 2500)
  }

  // Rolling restart: restart each container in sequence with 3s delay
  async function handleRollingRestart(groupKey: string, groupContainers: Container[]) {
    setRollingRestart(groupKey)
    const running = groupContainers.filter((c) => c.state === 'running')
    for (const c of running) {
      await fetch('/api/containers/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointId: c.endpointId, containerId: c.id, action: 'restart' }),
      }).catch(() => {})
      await new Promise((r) => setTimeout(r, 3000))
    }
    setRollingRestart(null)
    refresh()
  }

  if (loading) return <div className="flex items-center justify-center h-24"><div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" /></div>
  if (containers.length === 0) return <div className="text-zinc-500 text-sm text-center py-12">Portainer not configured</div>

  const sorted = [...containers].sort((a, b) => a.name.localeCompare(b.name))
  const updateNames = new Set(updates.containers.filter((u) => u.has_update && !['ignored', 'completed', 'requested'].includes(u.user_status)).map((u) => u.name))

  // Build groups
  const assignedNames = new Set(Object.values(STACKS).flatMap((s) => s.containers))
  const allGroups: Array<{ key: string; label: string; items: Container[] }> = [
    ...Object.entries(STACKS).map(([key, def]) => ({
      key,
      label: def.label,
      items: sorted.filter((c) => def.containers.includes(c.name)),
    })).filter((g) => g.items.length > 0),
    {
      key: '_other',
      label: 'Other',
      items: sorted.filter((c) => !assignedNames.has(c.name)),
    },
  ].filter((g) => g.items.length > 0)

  // Apply search filter
  const searchLower = search.toLowerCase()
  const groups = searchLower
    ? allGroups.map((g) => ({ ...g, items: g.items.filter((c) => c.name.toLowerCase().includes(searchLower) || c.image.toLowerCase().includes(searchLower)) })).filter((g) => g.items.length > 0)
    : allGroups

  // Auto-collapse logic on first data load: collapse healthy all-running stacks with no updates
  if (!initializedRef.current && containers.length > 0) {
    initializedRef.current = true
    const auto: Record<string, boolean> = {}
    for (const g of allGroups) {
      const allRunning = g.items.every((c) => c.state === 'running')
      const hasUpdates = g.items.some((c) => updateNames.has(c.name))
      auto[g.key] = allRunning && !hasUpdates // collapse healthy groups
    }
    // Only set if we haven't set it yet
    setCollapsed((prev) => Object.keys(prev).length === 0 ? auto : prev)
  }

  const totalRunning = containers.filter((c) => c.state === 'running').length
  const totalStopped = containers.filter((c) => c.state !== 'running').length
  const byRisk = updates.containers.filter((u) => u.has_update && u.user_status !== 'ignored').reduce<Record<string, number>>((acc, u) => {
    const r = u.risk ?? 'unknown'
    acc[r] = (acc[r] ?? 0) + 1
    return acc
  }, {})

  const totalCpu = metrics.reduce((s, m) => s + m.cpu_percent, 0)
  const totalMem = metrics.reduce((s, m) => s + m.mem_mb, 0)

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
          <div className="w-2 h-2 rounded-full bg-green-400" />
          <span className="text-xs text-zinc-300 font-medium">{totalRunning} running</span>
        </div>
        {totalStopped > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
            <div className="w-2 h-2 rounded-full bg-zinc-600" />
            <span className="text-xs text-zinc-400">{totalStopped} stopped</span>
          </div>
        )}
        {metrics.length > 0 && (
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50 text-xs text-zinc-400">
            <span>CPU <span className="text-zinc-300 font-mono">{totalCpu.toFixed(1)}%</span></span>
            <span className="text-zinc-700">·</span>
            <span>MEM <span className="text-zinc-300 font-mono">{totalMem >= 1024 ? `${(totalMem / 1024).toFixed(1)}GB` : `${totalMem.toFixed(0)}MB`}</span></span>
          </div>
        )}
        {byRisk.major > 0 && <span className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/15 text-red-400 border border-red-800/40">{byRisk.major} major update{byRisk.major > 1 ? 's' : ''}</span>}
        {byRisk.minor > 0 && <span className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-800/40">{byRisk.minor} minor</span>}
        {(byRisk.patch ?? 0) + (byRisk.rebuild ?? 0) > 0 && <span className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-500/15 text-green-400 border border-green-800/40">{(byRisk.patch ?? 0) + (byRisk.rebuild ?? 0)} patch</span>}
        <div className="ml-auto flex items-center gap-2">
          {updates.checked_at && <span className="text-[10px] text-zinc-600">updated {formatTimeAgo(updates.checked_at)}</span>}
          <button
            onClick={() => setCollapsed(Object.fromEntries(allGroups.map((g) => [g.key, true])))}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800/60 text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Collapse all"
          >⊟ All</button>
          <button
            onClick={() => setCollapsed(Object.fromEntries(allGroups.map((g) => [g.key, false])))}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800/60 text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Expand all"
          >⊞ All</button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600 text-xs">⌕</span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter containers…"
          className="w-full pl-8 pr-4 py-2 bg-zinc-900/60 border border-zinc-800/60 rounded-lg text-xs text-zinc-300 placeholder-zinc-700 focus:outline-none focus:border-purple-700/50"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 text-xs">✕</button>
        )}
      </div>

      {/* Stack groups */}
      {groups.map((group) => {
        const stackDef = STACKS[group.key]
        const runningCount = group.items.filter((c) => c.state === 'running').length
        const hasStackUpdate = stackDef && group.items.some((c) => updateNames.has(c.name))
        const isCollapsed = collapsed[group.key] ?? false
        const allRunning = group.items.every((c) => c.state === 'running')
        const anyStopped = group.items.some((c) => c.state !== 'running')
        const isRolling = rollingRestart === group.key

        // Group CPU/mem aggregate
        const groupMetrics = group.items.map((c) => metricsMap.get(c.name)).filter(Boolean) as ContainerMetrics[]
        const groupCpu = groupMetrics.reduce((s, m) => s + m.cpu_percent, 0)
        const groupMem = groupMetrics.reduce((s, m) => s + m.mem_mb, 0)

        return (
          <div key={group.key}>
            {/* Group header — clickable to collapse */}
            <div
              className="flex items-center justify-between mb-2 cursor-pointer group/header"
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
            >
              <div className="flex items-center gap-3">
                <span className="text-zinc-700 text-xs group-hover/header:text-zinc-500 transition-colors select-none">
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest group-hover/header:text-zinc-400 transition-colors">
                  {group.label}
                </h3>
                <HealthBar running={runningCount} total={group.items.length} />
                {groupMetrics.length > 0 && !isCollapsed && (
                  <span className="text-[10px] text-zinc-700 tabular-nums">CPU {groupCpu.toFixed(1)}% · {groupMem.toFixed(0)}MB</span>
                )}
              </div>

              {/* Group actions — stop propagation so clicking doesn't collapse */}
              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {isRolling && (
                  <span className="text-[10px] text-purple-400 animate-pulse mr-1">↻ Rolling…</span>
                )}
                {allRunning && group.items.length > 1 && (
                  <button
                    onClick={() => handleRollingRestart(group.key, group.items)}
                    disabled={isRolling || !!stackUpdating}
                    className="text-[10px] px-2 py-1 rounded bg-purple-900/30 hover:bg-purple-900/50 disabled:opacity-40 text-purple-300 border border-purple-800/30 transition-colors"
                    title="Restart containers one at a time with 3s delay"
                  >
                    ↻ Rolling
                  </button>
                )}
                {allRunning && (
                  <button
                    onClick={() => handleGroupAction(group.items, 'restart')}
                    disabled={isRolling || !!stackUpdating}
                    className="text-[10px] px-2 py-1 rounded bg-zinc-800/60 hover:bg-zinc-700/60 disabled:opacity-40 text-zinc-400 border border-zinc-700/40 transition-colors"
                  >
                    ↻ All
                  </button>
                )}
                {allRunning && (
                  <button
                    onClick={() => handleGroupAction(group.items, 'stop')}
                    disabled={isRolling || !!stackUpdating}
                    className="text-[10px] px-2 py-1 rounded bg-red-950/30 hover:bg-red-900/40 disabled:opacity-40 text-red-400 border border-red-800/30 transition-colors"
                  >
                    ■ Stop All
                  </button>
                )}
                {anyStopped && (
                  <button
                    onClick={() => handleGroupAction(group.items, 'start')}
                    disabled={isRolling || !!stackUpdating}
                    className="text-[10px] px-2 py-1 rounded bg-green-950/30 hover:bg-green-900/40 disabled:opacity-40 text-green-400 border border-green-800/30 transition-colors"
                  >
                    ▶ Start All
                  </button>
                )}
                {hasStackUpdate && (
                  <>
                    <button
                      onClick={() => handleStackUpdate(group.key)}
                      disabled={stackUpdating === group.key || isRolling}
                      className="text-[10px] px-2.5 py-1 bg-amber-700/40 hover:bg-amber-600/50 disabled:opacity-50 text-amber-200 rounded border border-amber-600/30 transition-colors"
                    >
                      {stackUpdating === group.key ? '⟳ Updating…' : '↑ Update Stack'}
                    </button>
                    {stackError && stackUpdating === null && (
                      <span className="text-[10px] text-red-400 max-w-[200px] truncate" title={stackError}>{stackError}</span>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Container rows — hidden when collapsed */}
            {!isCollapsed && (
              <div className="space-y-1.5">
                {group.items.map((c) => (
                  <ContainerRow
                    key={c.id}
                    c={c}
                    update={updateMap.get(c.name)}
                    metrics={metricsMap.get(c.name)}
                    acting={acting}
                    rebuilding={rebuilding}
                    forceRestarting={forceRestarting}
                    actionLoading={actionLoading}
                    updateResult={updateResult}
                    onAction={handleAction}
                    onUpdateAction={handleUpdateAction}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
