'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface ContainerSummary { up: number; down: number; total: number; updates: number; majorUpdates: number }
interface TaskSummary { pending: number; active: number; completed: number; failed: number; blocked: number; total: number }
interface GoalsSummary { visionTitle: string | null; activeMilestones: number; completedMilestones: number; activeTasks: number; blockedCount: number }
interface SecuritySummary { score: number; critical: number; warning: number }

function ContainerPill() {
  const [summary, setSummary] = useState<ContainerSummary | null>(null)

  useEffect(() => {
    const load = () => Promise.all([
      fetch('/api/containers').then(r => r.json()),
      fetch('/api/containers/updates/state').then(r => r.json()).catch(() => ({ containers: [] })),
    ]).then(([cd, ud]) => {
      const containers: { state: string }[] = cd.containers ?? []
      const up = containers.filter(c => c.state === 'running').length
      const updList: { has_update: boolean; user_status: string; risk?: string }[] = ud.containers ?? []
      const pending = updList.filter(u => u.has_update && u.user_status !== 'ignored' && u.user_status !== 'completed')
      setSummary({
        up, down: containers.length - up, total: containers.length,
        updates: pending.length,
        majorUpdates: pending.filter(u => u.risk === 'major').length,
      })
    }).catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  const pct = summary ? Math.round((summary.up / Math.max(summary.total, 1)) * 100) : null
  const color = pct == null ? '#52525b' : summary!.down > 0 ? '#ef4444' : pct === 100 ? '#22c55e' : '#f59e0b'
  const updateColor = summary && summary.majorUpdates > 0 ? '#ef4444' : '#f59e0b'

  return (
    <Link
      href="/lab/containers"
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all hover:brightness-125"
      style={{
        background: `${color}12`,
        borderColor: `${color}30`,
        color,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="text-zinc-400 font-normal">containers</span>
      {summary ? (
        <>
          <span className="font-semibold tabular-nums" style={{ color }}>{summary.up}/{summary.total}</span>
          {summary.down > 0 && <span className="text-red-400 tabular-nums font-semibold">↓{summary.down}</span>}
          {summary.updates > 0 && (
            <span className="font-semibold tabular-nums" style={{ color: updateColor }}>↑{summary.updates}</span>
          )}
        </>
      ) : (
        <span className="text-zinc-600">—</span>
      )}
    </Link>
  )
}

function TaskPill() {
  const [summary, setSummary] = useState<TaskSummary | null>(null)

  useEffect(() => {
    const load = () =>
      fetch('/api/taskqueue')
        .then(r => r.json())
        .then(d => {
          const problems: { status: string }[] = d.problems ?? []
          const waiting: { status: string }[] = d.waiting ?? []
          const active: { status: string }[] = d.active ?? []
          const recent: { status: string }[] = d.recent ?? []
          const summary24h: Record<string, number> = d.summary24h ?? {}
          setSummary({
            pending: recent.filter(t => t.status === 'pending').length,
            active: active.length,
            completed: summary24h['completed'] ?? 0,
            failed: problems.filter(t => t.status === 'failed').length,
            blocked: [...problems.filter(t => t.status === 'escalated'), ...waiting.filter(t => t.status === 'blocked')].length,
            total: recent.length,
          })
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  // Derive dominant color: red > blocked amber > active blue > idle zinc-400
  const color = !summary ? '#71717a'
    : summary.failed > 0 ? '#ef4444'
    : summary.blocked > 0 ? '#f59e0b'
    : summary.active > 0 ? '#60a5fa'
    : '#71717a'

  return (
    <Link
      href="/lab/tasks"
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all hover:brightness-125"
      style={{
        background: `${color}12`,
        borderColor: `${color}30`,
        color,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="text-zinc-400 font-normal">tasks</span>
      {summary ? (
        <span className="flex items-center gap-1.5 tabular-nums">
          {summary.active > 0 && <span className="text-blue-400 font-semibold">{summary.active} active</span>}
          {summary.pending > 0 && <span className="text-zinc-300 font-semibold">{summary.pending} pending</span>}
          {summary.completed > 0 && <span className="text-green-400">{summary.completed} done</span>}
          {summary.failed > 0 && <span className="text-red-400 font-semibold">{summary.failed} failed</span>}
          {summary.blocked > 0 && <span className="text-amber-400 font-semibold">{summary.blocked} blocked</span>}
          {summary.active === 0 && summary.pending === 0 && summary.failed === 0 && summary.blocked === 0 && (
            <span style={{ color }}>idle</span>
          )}
        </span>
      ) : (
        <span className="text-zinc-500">—</span>
      )}
    </Link>
  )
}

function GoalsPill() {
  const [summary, setSummary] = useState<GoalsSummary | null>(null)

  useEffect(() => {
    const load = () =>
      fetch('/api/goals')
        .then(r => r.json())
        .then(d => {
          const flat: { level: string; status: string; title: string }[] = d.flat ?? []
          const vision = flat.find(g => g.level === 'vision' && g.status === 'active')
          const milestones = flat.filter(g => g.level === 'milestone')
          const tasks = flat.filter(g => g.level === 'objective' || g.level === 'task')
          setSummary({
            visionTitle: vision?.title ?? null,
            activeMilestones: milestones.filter(g => g.status === 'active').length,
            completedMilestones: milestones.filter(g => g.status === 'completed').length,
            activeTasks: tasks.filter(g => g.status === 'active').length,
            blockedCount: flat.filter(g => g.status === 'blocked').length,
          })
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])

  const accent = '#a78bfa'

  return (
    <Link
      href="/goals"
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all hover:brightness-125"
      style={{
        background: 'rgba(167,139,250,0.08)',
        borderColor: 'rgba(167,139,250,0.28)',
        color: accent,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accent }} />
      <span className="text-zinc-400 font-normal">vision</span>
      {summary ? (
        <span className="flex items-center gap-1.5 tabular-nums">
          {summary.activeMilestones > 0 && (
            <span style={{ color: accent }} className="font-semibold">{summary.activeMilestones} milestones</span>
          )}
          {summary.activeTasks > 0 && (
            <span className="text-emerald-400 font-semibold">{summary.activeTasks} tasks</span>
          )}
          {summary.completedMilestones > 0 && (
            <span className="text-green-400">{summary.completedMilestones} done</span>
          )}
          {summary.blockedCount > 0 && (
            <span className="text-amber-400">{summary.blockedCount} blocked</span>
          )}
          {summary.activeMilestones === 0 && summary.activeTasks === 0 && summary.completedMilestones === 0 && summary.blockedCount === 0 && (
            <span style={{ color: accent }}>idle</span>
          )}
        </span>
      ) : (
        <span className="text-zinc-500">—</span>
      )}
    </Link>
  )
}

function SecurityPill() {
  const [summary, setSummary] = useState<SecuritySummary | null>(null)

  useEffect(() => {
    const load = () =>
      fetch('/api/security')
        .then(r => r.json())
        .then(d => {
          if (d.error) return
          setSummary({ score: d.score ?? 0, critical: d.counts?.critical ?? 0, warning: d.counts?.warning ?? 0 })
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 120_000)
    return () => clearInterval(id)
  }, [])

  const color = !summary ? '#71717a'
    : summary.critical > 0 ? '#ef4444'
    : summary.score >= 85 ? '#22c55e'
    : summary.score >= 65 ? '#f59e0b'
    : '#ef4444'

  const scoreLabel = summary ? `${summary.score}` : '—'

  return (
    <a
      href="#security"
      onClick={(e) => {
        e.preventDefault()
        document.getElementById('security')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all hover:brightness-125 cursor-pointer"
      style={{
        background: `${color}12`,
        borderColor: `${color}30`,
        color,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="text-zinc-400 font-normal">security</span>
      <span className="font-semibold tabular-nums" style={{ color }}>{scoreLabel}</span>
      {summary && summary.critical > 0 && (
        <span className="text-red-400 font-semibold">{summary.critical} crit</span>
      )}
      {summary && summary.warning > 0 && summary.critical === 0 && (
        <span className="text-amber-400">{summary.warning} warn</span>
      )}
    </a>
  )
}

export default function StatusPills() {
  return (
    <div className="flex items-center gap-2">
      <GoalsPill />
      <ContainerPill />
      <TaskPill />
      <SecurityPill />
    </div>
  )
}
