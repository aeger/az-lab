'use client'

import { useEffect, useState, useCallback } from 'react'

type Urgency = 'critical' | 'high' | 'medium' | 'low'
type NotifStatus = 'unread' | 'read' | 'dismissed' | 'archived'

interface Notification {
  id: string
  source: string
  category: string
  urgency: Urgency
  severity: string
  status: NotifStatus
  title: string
  body: string
  timestamp: string
  receivedAt: string
  readAt?: string
  metadata?: Record<string, unknown>
}

interface HistoryResponse {
  notifications: Notification[]
  total: number
  offset: number
}

const URGENCY_COLOR: Record<Urgency, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#71717a',
}

const URGENCY_BG: Record<Urgency, string> = {
  critical: 'rgba(239,68,68,0.1)',
  high: 'rgba(249,115,22,0.1)',
  medium: 'rgba(234,179,8,0.1)',
  low: 'rgba(113,113,122,0.08)',
}

const SOURCE_EMOJI: Record<string, string> = {
  task_queue: '📋',
  services: '🔧',
  home_assistant: '🏡',
  discord: '💬',
  grafana: '📊',
}

type FilterStatus = 'all' | 'unread' | 'read' | 'archived'
type FilterUrgency = 'all' | Urgency
type FilterSource = 'all' | string

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterUrgency, setFilterUrgency] = useState<FilterUrgency>('all')
  const [filterSource, setFilterSource] = useState<FilterSource>('all')
  const [days, setDays] = useState(7)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)

  const LIMIT = 50

  const fetchHistory = useCallback(async (newOffset = 0) => {
    setLoading(true)
    const params = new URLSearchParams({
      limit: String(LIMIT),
      offset: String(newOffset),
      days: String(days),
    })
    if (filterStatus !== 'all') params.set('status', filterStatus)
    if (filterUrgency !== 'all') params.set('urgency', filterUrgency)
    if (filterSource !== 'all') params.set('source', filterSource)

    try {
      const res = await fetch(`/api/notifications/history?${params}`)
      if (res.ok) {
        const data: HistoryResponse = await res.json()
        setNotifications(data.notifications)
        setTotal(data.total)
        setOffset(newOffset)
      }
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterUrgency, filterSource, days])

  useEffect(() => {
    fetchHistory(0)
  }, [fetchHistory])

  async function markRead(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' })
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, status: 'read' as const, readAt: new Date().toISOString() } : n))
  }

  async function markAllRead() {
    await fetch('/api/notifications/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setNotifications(prev => prev.map(n => ({ ...n, status: 'read' as const })))
  }

  async function archiveOld() {
    setArchiving(true)
    try {
      const res = await fetch('/api/notifications/archive', { method: 'DELETE' })
      if (res.ok) {
        const data = await res.json()
        // Refresh to reflect archived state
        await fetchHistory(0)
        return data.archived ?? 0
      }
    } finally {
      setArchiving(false)
    }
    return 0
  }

  const sources = [...new Set(notifications.map(n => n.source))]
  const unreadCount = notifications.filter(n => n.status === 'unread').length
  const archivedCount = notifications.filter(n => n.status === 'archived').length

  return (
    <main className="min-h-screen px-4 py-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            <span>🔔</span> Notification History
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            {total} total · {unreadCount} unread{archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={archiveOld}
            disabled={archiving}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#52525b' }}
            title="Move read notifications older than 30 days to archive"
          >
            {archiving ? 'Archiving…' : 'Archive old (30d+)'}
          </button>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa' }}
            >
              Mark all read
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div
        className="flex flex-wrap items-center gap-2 mb-5 p-3 rounded-xl"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        {/* Status filter */}
        <div className="flex items-center gap-1">
          {(['all', 'unread', 'read', 'archived'] as FilterStatus[]).map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-all"
              style={filterStatus === s
                ? { background: 'rgba(139,92,246,0.2)', color: '#c084fc', border: '1px solid rgba(139,92,246,0.4)' }
                : { background: 'transparent', color: '#71717a', border: '1px solid rgba(255,255,255,0.07)' }
              }
            >
              {s}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-white/10" />

        {/* Urgency filter */}
        <div className="flex items-center gap-1">
          {(['all', 'critical', 'high', 'medium', 'low'] as (FilterUrgency)[]).map(u => {
            const color = u === 'all' ? '#71717a' : URGENCY_COLOR[u as Urgency]
            return (
              <button
                key={u}
                onClick={() => setFilterUrgency(u)}
                className="px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-all"
                style={filterUrgency === u
                  ? { background: `${color}25`, color, border: `1px solid ${color}60` }
                  : { background: 'transparent', color: '#71717a', border: '1px solid rgba(255,255,255,0.07)' }
                }
              >
                {u}
              </button>
            )
          })}
        </div>

        <div className="w-px h-4 bg-white/10" />

        {/* Days filter */}
        <div className="flex items-center gap-1">
          {[1, 7, 14, 30].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className="px-2 py-1 rounded text-[10px] transition-all"
              style={days === d
                ? { background: 'rgba(255,255,255,0.1)', color: '#e4e4e7' }
                : { color: '#52525b' }
              }
            >
              {d}d
            </button>
          ))}
        </div>

        {/* Source filter */}
        {sources.length > 1 && (
          <>
            <div className="w-px h-4 bg-white/10" />
            <select
              value={filterSource}
              onChange={e => setFilterSource(e.target.value)}
              className="text-[11px] rounded px-2 py-1"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa', outline: 'none' }}
            >
              <option value="all">All sources</option>
              {sources.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </>
        )}
      </div>

      {/* Notification list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-zinc-600 text-sm animate-pulse">Loading history...</div>
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span style={{ fontSize: '36px', marginBottom: '12px' }}>✅</span>
          <p className="text-zinc-500">No notifications match these filters</p>
        </div>
      ) : (
        <div className="space-y-1">
          {notifications.map(n => {
            const color = URGENCY_COLOR[n.urgency]
            const isRead = n.status === 'read' || n.status === 'archived'
            const isExpanded = expanded === n.id
            const emoji = SOURCE_EMOJI[n.source] || '🔔'

            return (
              <div
                key={n.id}
                className="rounded-lg cursor-pointer transition-all"
                style={{
                  background: isRead ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isRead ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)'}`,
                  borderLeft: `3px solid ${isRead ? color + '40' : color}`,
                  opacity: isRead ? 0.6 : 1,
                }}
                onClick={() => setExpanded(isExpanded ? null : n.id)}
              >
                <div className="flex items-start gap-3 px-4 py-3">
                  <span style={{ fontSize: '16px', flexShrink: 0, marginTop: '2px' }}>{emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <p
                        className="text-sm font-medium leading-tight"
                        style={{ color: isRead ? '#52525b' : '#e4e4e7' }}
                      >
                        {n.title}
                        {isRead && (
                          <span className="ml-2 text-[9px] text-zinc-700 font-normal">
                            {n.status === 'archived' ? 'archived' : 'read'}
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
                          style={{ background: URGENCY_BG[n.urgency], color }}
                        >
                          {n.urgency}
                        </span>
                        {!isRead && (
                          <button
                            onClick={e => { e.stopPropagation(); markRead(n.id) }}
                            className="text-zinc-700 hover:text-zinc-400 text-xs transition-colors"
                            title="Mark read"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(255,255,255,0.04)', color: '#52525b' }}
                      >
                        {n.category.replace(/_/g, ' ')}
                      </span>
                      <span className="text-zinc-800 text-[10px]">·</span>
                      <span className="text-[10px] text-zinc-700" title={formatDate(n.timestamp)}>
                        {timeAgo(n.timestamp)}
                      </span>
                      {n.readAt && (
                        <>
                          <span className="text-zinc-800 text-[10px]">·</span>
                          <span className="text-[10px] text-zinc-700">read {timeAgo(n.readAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && n.body && (
                  <div
                    className="px-4 pb-3 pt-0"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <p className="text-xs text-zinc-400 leading-relaxed mt-2 whitespace-pre-wrap">{n.body}</p>
                    {n.metadata && Object.keys(n.metadata).length > 0 && (
                      <details className="mt-2">
                        <summary className="text-[10px] text-zinc-700 cursor-pointer hover:text-zinc-500">
                          Metadata
                        </summary>
                        <pre className="text-[10px] text-zinc-700 mt-1 overflow-auto max-h-24">
                          {JSON.stringify(n.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                    <p className="text-[10px] text-zinc-700 mt-2">{formatDate(n.timestamp)}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Pagination */}
      {total > LIMIT && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={() => fetchHistory(Math.max(0, offset - LIMIT))}
            disabled={offset === 0 || loading}
            className="px-4 py-2 rounded-lg text-xs font-medium disabled:opacity-30 transition-opacity"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa' }}
          >
            ← Previous
          </button>
          <span className="text-xs text-zinc-600">
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            onClick={() => fetchHistory(offset + LIMIT)}
            disabled={offset + LIMIT >= total || loading}
            className="px-4 py-2 rounded-lg text-xs font-medium disabled:opacity-30 transition-opacity"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa' }}
          >
            Next →
          </button>
        </div>
      )}
    </main>
  )
}
